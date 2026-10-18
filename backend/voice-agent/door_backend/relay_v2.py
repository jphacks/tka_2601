"""Device-controlled turns on the existing /api/relay WebSocket (version 2).

JSON control and raw PCM share one ordered socket. Only a completed, validated
input is submitted to ASR; only acknowledged physical playout releases a reply.
V1's RTC worker path is intentionally unchanged.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

import anyio
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from .config import settings
from .house_rules import build_house_rules
from .relay import (
    CLOSE_NORMAL,
    CLOSE_SERVER_ERROR,
    RelayError,
    RelayErrorCode,
    StartMessage,
    fetch_house_settings,
    _send_error,
)
from .relay_agent import DeviceAgent
from .supabase_history import write_visit

logger = logging.getLogger("door-relay")
FRAME_BYTES = 640
MAX_INPUT_FRAMES = 1500
MAX_OUTPUT_SAMPLES = 16000 * 60
OUTPUT_WINDOW = 10
CALL_START_SECONDS = 65
RESPONSE_SECONDS = 90
PLAYBACK_SECONDS = 75
END_SECONDS = 65


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def integer(payload: dict, key: str, expected: int | None = None) -> int:
    value = payload.get(key)
    if type(value) is not int or value < 0:
        raise RelayError(RelayErrorCode.INVALID_MESSAGE, f"Invalid {key}.")
    if expected is not None and value != expected:
        raise RelayError(RelayErrorCode.INVALID_MESSAGE, f"Invalid {key}.")
    return value


class DeviceConversation:
    def __init__(self, websocket: WebSocket, start: StartMessage):
        self.websocket = websocket
        self.start = start
        self.runtime: DeviceAgent | None = None
        self.utterances: list[dict[str, str]] = []
        self.chimed_at = now()
        self.answered_at: str | None = None
        self.state = "preparing"
        self.turn = 0
        self._pcm = bytearray()
        self._input_frames = 0
        self._input_deadline = 0.0
        self._pcm_deadline = 0.0
        self.output_frames = 0
        self.output_samples = 0
        self.ack_frames = 0
        self.output_ended = False
        self.end_call = False
        self._ack_changed = asyncio.Condition()
        self._send_lock = asyncio.Lock()
        self._model: asyncio.Task | None = None
        self._deadline = float("inf")
        self._call_deadline = float("inf")

    async def send(self, payload: dict | bytes) -> None:
        async with self._send_lock:
            if isinstance(payload, bytes):
                await asyncio.wait_for(self.websocket.send_bytes(payload), 5)
            else:
                await asyncio.wait_for(self.websocket.send_json(payload), 5)

    async def transcript(self, speaker: str, text: str) -> None:
        self.utterances.append({"speaker": speaker, "text": text, "spoken_at": now()})
        # USB/Web UI logs use these events too. Retain full text in history,
        # but bound each event for E84's fixed WebSocket control-frame buffer.
        payload = {"type": "transcript", "speaker": speaker, "text": text[:120]}
        while len(json.dumps(payload, ensure_ascii=True).encode("utf-8")) > 1024:
            payload["text"] = payload["text"][:-1]
        await self.send(payload)

    async def write_audio(self, pcm: bytes) -> None:
        output_open = self.state == "processing" and not self.output_ended
        if not output_open:
            raise RelayError(
                RelayErrorCode.INVALID_OUTPUT, "Invalid agent audio boundary.", CLOSE_SERVER_ERROR
            )
        valid_pcm = bool(pcm) and len(pcm) % 2 == 0 and len(pcm) <= FRAME_BYTES
        if not valid_pcm:
            raise RelayError(
                RelayErrorCode.INVALID_OUTPUT, "Invalid agent audio boundary.", CLOSE_SERVER_ERROR
            )
        if self.output_samples + len(pcm) // 2 > MAX_OUTPUT_SAMPLES:
            raise RelayError(
                RelayErrorCode.OUTPUT_LIMIT, "Agent audio exceeds 60 seconds.", CLOSE_SERVER_ERROR
            )
        async with self._ack_changed:
            await asyncio.wait_for(self._ack_changed.wait_for(
                lambda: self.output_frames - self.ack_frames < OUTPUT_WINDOW
            ), 10)
        if not self.output_frames:
            await self.send({"type": "output_start", "turn_id": self.turn, "output_id": self.turn})
        self.output_frames += 1
        self.output_samples += len(pcm) // 2
        await self.send(pcm)

    async def finish_audio(self) -> None:
        if self.state != "processing" or self.output_ended or not self.output_frames:
            raise RelayError(
                RelayErrorCode.INVALID_OUTPUT, "Invalid agent output completion.", CLOSE_SERVER_ERROR
            )
        assert self.runtime
        self.end_call = self.turn > 0 and self.runtime.end_after_reply()
        # State is updated before send: an immediate peer acknowledgement is valid.
        self.output_ended = True
        self.state = "playback"
        self._deadline = asyncio.get_running_loop().time() + PLAYBACK_SECONDS
        await self.send({"type": "output_end", "turn_id": self.turn, "output_id": self.turn,
                         "frames": self.output_frames, "samples": self.output_samples,
                         "end_call": self.end_call})

    async def _generate(self, pcm: bytes | None) -> None:
        assert self.runtime
        if pcm is None:
            await self.runtime.reply(None)
        else:
            text = await self.runtime.recognize(pcm)
            if text:
                await self.runtime.reply(text)

    def generate(self, pcm: bytes | None) -> None:
        self.state = "processing"
        self.output_frames = self.output_samples = self.ack_frames = 0
        self.output_ended = self.end_call = False
        self._deadline = asyncio.get_running_loop().time() + RESPONSE_SECONDS
        self._model = asyncio.create_task(self._generate(pcm))

    async def listen(self) -> None:
        if self.turn >= 20:
            await self.hangup("turn_limit")
            return
        self.turn += 1
        self.state = "listening"
        self._deadline = asyncio.get_running_loop().time() + 60
        await self.send({"type": "listen", "turn_id": self.turn})

    async def hangup(self, reason: str) -> None:
        self.state = "ending"
        self._deadline = asyncio.get_running_loop().time() + END_SECONDS
        # Allow the physical end-button operation to complete after the call limit.
        self._call_deadline = float("inf")
        await self.send({"type": "call_end", "turn_id": self.turn, "reason": reason})

    async def received(self, message: dict) -> bool:
        if message["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", CLOSE_NORMAL))
        pcm = message.get("bytes")
        if pcm is not None:
            if self.state != "input" or len(pcm) != FRAME_BYTES:
                raise RelayError(
                    RelayErrorCode.INVALID_AUDIO, "Input PCM must be 640 bytes during an input turn."
                )
            if self._input_frames >= MAX_INPUT_FRAMES:
                raise RelayError(RelayErrorCode.INPUT_LIMIT, "Input audio exceeds 30 seconds.")
            if not self._input_frames:
                self._input_deadline = asyncio.get_running_loop().time() + 35
                self._deadline = self._input_deadline
            self._pcm.extend(pcm)
            self._input_frames += 1
            self._pcm_deadline = asyncio.get_running_loop().time() + 5
            return False
        try:
            if len((message.get("text") or "").encode("utf-8")) > 1024:
                raise RelayError(RelayErrorCode.INVALID_MESSAGE, "Control message is too large.")
            payload = json.loads(message.get("text") or "")
        except ValueError as exc:
            raise RelayError(RelayErrorCode.INVALID_MESSAGE, "Expected a JSON object.") from exc
        if not isinstance(payload, dict):
            raise RelayError(RelayErrorCode.INVALID_MESSAGE, "Expected a JSON object.")
        kind = payload.get("type")
        if kind in {"cancel", "end"}:
            return True
        if kind in {"ping", "pong"}:
            ping_turn = integer(payload, "turn_id")
            seq = integer(payload, "seq")
            if ping_turn > self.turn or ping_turn < max(0, self.turn - 1):
                raise RelayError(RelayErrorCode.INVALID_MESSAGE, "Stale keepalive generation.")
            if kind == "ping":
                await self.send({"type": "pong", "turn_id": ping_turn, "seq": seq})
            return False
        if kind == "call_started" and self.state == "ready":
            integer(payload, "turn_id", 0)
            self.answered_at = now()
            self._call_deadline = asyncio.get_running_loop().time() + settings.relay_max_session_seconds
            self.generate(None)
            return False
        integer(payload, "turn_id", self.turn)
        if kind == "input_start" and self.state == "listening":
            self.state = "input"
            self._pcm.clear()
            self._input_frames = 0
            # input_start arms E84's VAD. Its first actual speech frame may arrive
            # much later, so the 30-second recording clock has not started yet.
            self._input_deadline = asyncio.get_running_loop().time() + 60
            self._pcm_deadline = self._input_deadline
            self._deadline = self._input_deadline
        elif kind == "input_end" and self.state == "input":
            integer(payload, "frames", self._input_frames)
            integer(payload, "samples", self._input_frames * 320)
            reason = payload.get("reason")
            if not self._input_frames:
                raise RelayError(RelayErrorCode.INVALID_INPUT_END, "Invalid input boundary.")
            valid_reason = reason in {"silence", "max_duration"}
            truncated_max_duration = (
                reason == "max_duration" and self._input_frames != MAX_INPUT_FRAMES
            )
            if not valid_reason or truncated_max_duration:
                raise RelayError(RelayErrorCode.INVALID_INPUT_END, "Invalid input boundary.")
            # Single receive loop consumed all binary messages before this JSON.
            pcm = bytes(self._pcm)
            self._pcm.clear()
            self.generate(pcm)
        elif kind == "audio_ack" and self.state in {"processing", "playback"}:
            integer(payload, "output_id", self.turn)
            frames = integer(payload, "frames")
            if frames < self.ack_frames or frames > self.output_frames:
                raise RelayError(
                    RelayErrorCode.INVALID_ACK, "Audio acknowledgement is out of range."
                )
            async with self._ack_changed:
                self.ack_frames = frames
                self._ack_changed.notify_all()
        elif kind == "playback_done" and self.state == "playback":
            integer(payload, "output_id", self.turn)
            integer(payload, "frames", self.output_frames)
            integer(payload, "samples", self.output_samples)
            if not self.output_ended or self.ack_frames != self.output_frames:
                raise RelayError(
                    RelayErrorCode.INVALID_PLAYBACK, "All output must be acknowledged before playback completion."
                )
            self.state = "played"
            self._deadline = asyncio.get_running_loop().time() + 10
            assert self.runtime
            self.runtime.played()
        elif kind == "call_ended" and self.state == "ending":
            return True
        else:
            raise RelayError(
                RelayErrorCode.INVALID_STATE, "Message is invalid for the current turn."
            )
        return False

    async def run(self) -> None:
        house = await fetch_house_settings(self.start.device_key)
        rules = build_house_rules(self.start.mode, house, settings.max_house_rules_chars)
        self.runtime = DeviceAgent(rules, self.write_audio, self.finish_audio, self.transcript)
        await asyncio.wait_for(self.runtime.start(), 55)
        self.state = "ready"
        self._deadline = asyncio.get_running_loop().time() + CALL_START_SECONDS
        await self.send({"type": "ready", "protocol_version": 2})
        receive = asyncio.create_task(self.websocket.receive())
        try:
            while True:
                current = asyncio.get_running_loop().time()
                deadline = min(self._deadline, self._call_deadline)
                if self.state == "input":
                    deadline = min(deadline, self._pcm_deadline)
                waits = {receive}
                if self._model is not None:
                    waits.add(self._model)
                done, _ = await asyncio.wait(waits, timeout=max(0, deadline - current), return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    raise RelayError(
                        RelayErrorCode.TIME_LIMIT, "Conversation or state deadline expired."
                    )
                if receive in done:
                    if await self.received(receive.result()):
                        await self.websocket.close(CLOSE_NORMAL)
                        return
                    receive = asyncio.create_task(self.websocket.receive())
                if self._model is not None and self._model in done:
                    task, self._model = self._model, None
                    task.result()
                    if not self.output_frames:
                        if self.turn == 0:
                            raise RelayError(
                                RelayErrorCode.EMPTY_GREETING, "Greeting audio is unavailable.", CLOSE_SERVER_ERROR
                            )
                        await self.send({"type": "no_reply", "turn_id": self.turn})
                        await self.listen()
                    elif self.state != "played":
                        raise RelayError(
                            RelayErrorCode.INVALID_OUTPUT, "Agent completed before physical playout.", CLOSE_SERVER_ERROR
                        )
                    elif self.end_call:
                        await self.hangup("completed")
                    else:
                        await self.listen()
        finally:
            receive.cancel()
            await asyncio.gather(receive, return_exceptions=True)

    async def aclose(self) -> None:
        if self._model is not None:
            self._model.cancel()
            await asyncio.gather(self._model, return_exceptions=True)
        if self.runtime is not None:
            await self.runtime.aclose()
        self._pcm.clear()


async def serve_v2(websocket: WebSocket, start: StartMessage) -> None:
    conversation = DeviceConversation(websocket, start)
    end_code = None
    try:
        await conversation.run()
    except RelayError as error:
        end_code = error.code
        await _send_error(websocket, error)
    except WebSocketDisconnect:
        end_code = "disconnected"
    except Exception as exc:
        end_code = RelayErrorCode.AGENT_UNAVAILABLE
        logger.warning("relay v2 failed: %s", type(exc).__name__)
        await _send_error(websocket, RelayError(end_code, "Voice processing failed.", CLOSE_SERVER_ERROR))
    finally:
        # ASGI disconnect cancels the request scope; the bounded cleanup must still
        # close model HTTP clients and release the session's output buffers.
        with anyio.CancelScope(shield=True):
            try:
                await asyncio.wait_for(conversation.aclose(), 10)
            finally:
                if conversation.answered_at is not None:
                    try:
                        await write_visit(settings, start.device_key, start.visit_id, start.mode,
                            chimed_at=conversation.chimed_at, answered_at=conversation.answered_at,
                            utterances=conversation.utterances, end_code=end_code, end_json=None)
                    except Exception as exc:
                        logger.warning("visit history write failed: %s", type(exc).__name__)
