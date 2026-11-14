"""WebSocket relay that joins a LiveKit room on behalf of the PSoC 6 (spec.md 5.4).

PSoC 6 -> relay: a start JSON, then 16 kHz/16-bit/mono PCM as binary messages, then an end JSON.
relay -> PSoC 6: a ready JSON, the agent's voice as the same PCM, final transcripts, agent
states and errors as JSON.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from logging.handlers import RotatingFileHandler
from pathlib import Path
from datetime import UTC, datetime
from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol
from uuid import UUID

from fastapi import WebSocket
from livekit import api, rtc
from pydantic import BaseModel, Field, ValidationError
from starlette.websockets import WebSocketDisconnect

from ..config import settings
from ..core.house_rules import Mode, build_house_rules
from ..persistence.device_api import DeviceSettings, fetch_device_settings
from ..persistence.supabase_history import write_visit

logger = logging.getLogger("door-relay")

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2
MAX_AUDIO_MESSAGE_BYTES = FRAME_BYTES * 5
TRANSCRIPTION_TOPIC = "lk.transcription"
AGENT_SESSION_TOPIC = "lk.agent.session"
ATTRIBUTE_TRANSCRIPTION_FINAL = "lk.transcription_final"
ATTRIBUTE_TRANSCRIPTION_TRACK_ID = "lk.transcribed_track_id"
ATTRIBUTE_AGENT_STATE = "lk.agent.state"
FORWARDED_AGENT_STATES = {"speaking", "listening", "thinking"}

CLOSE_NORMAL = 1000
CLOSE_POLICY = 1008
CLOSE_SERVER_ERROR = 1011
CLOSE_TRY_AGAIN_LATER = 1013

# Items the LiveKit side hands to the WebSocket side.
Outbound = tuple[Literal["audio", "json", "closed"], Any]
# (room, house_rules, reception) -> dispatch the LiveKit agent. ``reception`` is set only
# for a device whose household is a shop; see reception_metadata().
Dispatch = Callable[[str, str, dict[str, Any] | None], Awaitable[None]]


def configure_event_log() -> None:
    if not settings.relay_log_path:
        return
    path = Path(settings.relay_log_path).resolve()
    if any(isinstance(handler, RotatingFileHandler) and handler.baseFilename == str(path)
           for handler in logger.handlers):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(path, maxBytes=1024 * 1024, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


class RelayError(Exception):
    def __init__(self, code: str, message: str, close_code: int = CLOSE_POLICY) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.close_code = close_code


class StartMessage(BaseModel):
    type: Literal["start"]
    protocol_version: Literal[1, 2] = 1
    visit_id: UUID
    mode: Mode
    # Diagnostic calls before device pairing have no resident key. They still
    # authenticate the WebSocket with the API key, but skip resident data/history.
    device_key: str | None = Field(default=None, min_length=1, max_length=512, pattern=r"^[\x21-\x7e]+$")


class AgentLink(Protocol):
    async def send_audio(self, pcm: bytes) -> None: ...

    async def aclose(self) -> None: ...


class LiveKitLink:
    """Joins the room as the visitor, publishes PSoC audio and forwards the agent's output."""

    def __init__(self, outbox: asyncio.Queue[Outbound]) -> None:
        self._outbox = outbox
        self.utterances: list[dict[str, str]] = []
        self._room = rtc.Room()
        self._source = rtc.AudioSource(SAMPLE_RATE, 1)
        self._track_sid: str | None = None
        self._agent_speaking = False
        self._tasks: set[asyncio.Task] = set()

    async def connect(self, url: str, token: str) -> None:
        room = self._room
        room.on("track_subscribed", self._on_track_subscribed)
        room.on("participant_attributes_changed", self._on_attributes_changed)
        room.on("disconnected", self._on_disconnected)
        room.register_text_stream_handler(TRANSCRIPTION_TOPIC, self._on_transcription)
        # Session events for LiveKit's own tools; drained so they are not logged one by one.
        room.register_byte_stream_handler(AGENT_SESSION_TOPIC, self._discard_stream)
        await room.connect(url, token, rtc.RoomOptions(auto_subscribe=True))
        track = rtc.LocalAudioTrack.create_audio_track("psoc-mic", self._source)
        publication = await room.local_participant.publish_track(
            track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        )
        self._track_sid = publication.sid

    async def send_audio(self, pcm: bytes) -> None:
        frame = rtc.AudioFrame(pcm, SAMPLE_RATE, 1, len(pcm) // 2)
        await self._source.capture_frame(frame)

    async def aclose(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._room.off("disconnected", self._on_disconnected)
        self._room.unregister_text_stream_handler(TRANSCRIPTION_TOPIC)
        self._room.unregister_byte_stream_handler(AGENT_SESSION_TOPIC)
        await self._room.disconnect()
        await self._source.aclose()

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)

    def _task_done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.warning("relay forwarding failed: %s", type(task.exception()).__name__)

    @staticmethod
    def _is_agent(participant: rtc.Participant) -> bool:
        return participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT

    def _on_track_subscribed(self, track, _publication, participant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO and self._is_agent(participant):
            self._spawn(self._forward_agent_audio(track))

    async def _forward_agent_audio(self, track: rtc.Track) -> None:
        stream = rtc.AudioStream(
            track, sample_rate=SAMPLE_RATE, num_channels=1, frame_size_ms=FRAME_MS
        )
        try:
            async for event in stream:
                pcm = bytes(event.frame.data)
                # The agent's track carries digital silence between replies. Forwarding it would
                # keep the PSoC 6 in playback, where it stops sending the microphone (spec 3.7).
                if self._agent_speaking or any(pcm):
                    self._outbox.put_nowait(("audio", pcm))
        finally:
            await stream.aclose()

    def _on_attributes_changed(self, changed: dict[str, str], participant) -> None:
        state = changed.get(ATTRIBUTE_AGENT_STATE)
        if not self._is_agent(participant) or state not in FORWARDED_AGENT_STATES:
            return
        self._agent_speaking = state == "speaking"
        self._outbox.put_nowait(("json", {"type": "agent_state", "state": state}))

    def _on_transcription(self, reader: rtc.TextStreamReader, participant_identity: str) -> None:
        self._spawn(self._forward_transcript(reader, participant_identity))

    async def _forward_transcript(self, reader: rtc.TextStreamReader, participant_identity: str) -> None:
        attributes = reader.info.attributes or {}
        text = (await reader.read_all()).strip()
        # The agent publishes the visitor's transcript under the visitor's identity and track.
        visitor = participant_identity == self._room.local_participant.identity or (
            self._track_sid is not None
            and attributes.get(ATTRIBUTE_TRANSCRIPTION_TRACK_ID) == self._track_sid
        )
        # Visitor transcripts arrive as one stream per interim result; the agent's reply is
        # one stream per segment that ends when the segment is final.
        if visitor and attributes.get(ATTRIBUTE_TRANSCRIPTION_FINAL) != "true":
            return
        if text:
            speaker = "visitor" if visitor else "ai"
            utterance = {
                "speaker": speaker,
                "text": text,
                "spoken_at": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            }
            if hasattr(self, "utterances"):
                self.utterances.append(utterance)
            self._outbox.put_nowait(("json", {"type": "transcript", "speaker": speaker, "text": text}))

    def _discard_stream(self, reader: rtc.ByteStreamReader, _participant_identity: str) -> None:
        async def drain() -> None:
            async for _chunk in reader:
                pass

        self._spawn(drain())

    def _on_disconnected(self, _reason) -> None:
        self._outbox.put_nowait(("closed", "livekit_disconnected"))


def participant_token(room: str, identity: str) -> str:
    return (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(identity)
        .with_name("来訪者")
        .with_grants(
            api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True)
        )
        .to_jwt()
    )


async def connect_agent_room(room: str, identity: str, outbox: asyncio.Queue[Outbound]) -> AgentLink:
    link = LiveKitLink(outbox)
    try:
        await link.connect(settings.relay_livekit_url, participant_token(room, identity))
    except BaseException:
        await link.aclose()
        raise
    return link


async def delete_room(room: str) -> None:
    try:
        async with api.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as client:
            await asyncio.wait_for(client.room.delete_room(api.DeleteRoomRequest(room=room)), 5)
    except Exception as exc:
        logger.info("room cleanup failed: %s", type(exc).__name__)


def reception_metadata(device_key: str | None, device: DeviceSettings | None) -> dict[str, Any] | None:
    """Shop devices get the reception agent; homes and unpaired devices get the door agent."""
    if device_key is None or device is None or device.shop is None:
        return None
    return {"device_key": device_key, "shop": device.shop.to_json()}


async def _receive_start(websocket: WebSocket) -> StartMessage:
    try:
        message = await asyncio.wait_for(
            websocket.receive(), timeout=settings.relay_start_timeout_seconds
        )
    except asyncio.TimeoutError as exc:
        raise RelayError("start_timeout", "開始の JSON が届きません。") from exc
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", CLOSE_NORMAL))
    try:
        start = StartMessage.model_validate_json(message.get("text") or "")
        # This exact non-secret sentinel is emitted by E84's unpaired diagnostic
        # client. It is not a registered household key.
        if start.device_key == "e84-diagnostic-unpaired":
            start.device_key = None
        return start
    except ValidationError as exc:
        fields = [
            {"field": ".".join(str(part) for part in error["loc"]), "reason": error["type"]}
            for error in exc.errors()
        ]
        logger.warning("relay invalid start fields=%s", fields)
        raise RelayError("invalid_start", "開始の JSON の形が違います。") from exc


async def _pump_inbound(websocket: WebSocket, link: AgentLink) -> str:
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return "disconnected"
        data = message.get("bytes")
        if data is not None:
            if not data or len(data) % 2 or len(data) > MAX_AUDIO_MESSAGE_BYTES:
                raise RelayError("invalid_audio", "音声は 16bit の PCM を 100 ms 以下ずつ送ってください。")
            await link.send_audio(data)
            continue
        try:
            payload = json.loads(message.get("text") or "")
        except ValueError as exc:
            raise RelayError("invalid_message", "テキストのメッセージは JSON にしてください。") from exc
        if not isinstance(payload, dict):
            raise RelayError("invalid_message", "テキストのメッセージは JSON のオブジェクトにしてください。")
        if payload.get("type") == "end":
            return "end"


async def _pump_outbound(websocket: WebSocket, outbox: asyncio.Queue[Outbound]) -> None:
    while True:
        kind, value = await outbox.get()
        if kind == "audio":
            await websocket.send_bytes(value)
        elif kind == "json":
            await websocket.send_json(value)
        else:
            raise RelayError(value, "会話サーバーとの接続が切れました。", CLOSE_SERVER_ERROR)


async def _flush_messages(websocket: WebSocket, outbox: asyncio.Queue[Outbound]) -> None:
    """Send JSON that is already queued, such as the last transcript, before closing."""
    while not outbox.empty():
        kind, value = outbox.get_nowait()
        if kind == "json":
            await websocket.send_json(value)


async def _converse(websocket: WebSocket, link: AgentLink, outbox: asyncio.Queue[Outbound]) -> None:
    inbound = asyncio.create_task(_pump_inbound(websocket, link))
    outbound = asyncio.create_task(_pump_outbound(websocket, outbox))
    try:
        done, _ = await asyncio.wait(
            {inbound, outbound},
            timeout=settings.relay_max_session_seconds,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if not done:
            raise RelayError("time_limit", "会話の上限時間を過ぎました。")
        for task in done:
            task.result()
    finally:
        for task in (inbound, outbound):
            task.cancel()
        await asyncio.gather(inbound, outbound, return_exceptions=True)
    if inbound.done() and not inbound.cancelled() and inbound.result() == "end":
        await _flush_messages(websocket, outbox)
        await websocket.close(CLOSE_NORMAL)


async def _send_error(websocket: WebSocket, error: RelayError) -> None:
    try:
        await websocket.send_json({"type": "error", "code": error.code, "message": error.message})
        await websocket.close(error.close_code)
    except (RuntimeError, WebSocketDisconnect):
        pass


async def serve(websocket: WebSocket, dispatch: Dispatch) -> None:
    """Run one conversation. The caller has authenticated and accepted the WebSocket."""
    link: AgentLink | None = None
    room = f"door-{secrets.token_hex(5)}"
    house_task: asyncio.Task | None = None
    started_at: str | None = None
    answered_at: str | None = None
    end_code: str | None = None
    try:
        start = await _receive_start(websocket)
        logger.info("relay accepted protocol=%s", start.protocol_version)
        if start.protocol_version == 2:
            from .v2 import serve_v2

            await serve_v2(websocket, start)
            return
        started_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        logger.info("relay start visit=%s mode=%s room=%s", start.visit_id, start.mode, room)
        outbox: asyncio.Queue[Outbound] = asyncio.Queue()
        # Read the settings while joining the room; the agent is dispatched once both are done.
        house_task = (
            asyncio.create_task(fetch_device_settings(start.device_key))
            if start.device_key is not None
            else None
        )
        try:
            link = await connect_agent_room(room, f"visitor-{secrets.token_hex(4)}", outbox)
            device = await house_task if house_task is not None else None
            rules = build_house_rules(start.mode, device.house if device else None, settings.max_house_rules_chars)
            await dispatch(room, rules, reception_metadata(start.device_key, device))
        except Exception as exc:
            logger.warning("relay could not start the agent: %s", type(exc).__name__)
            raise RelayError(
                "agent_unavailable", "音声エージェントを開始できません。", CLOSE_SERVER_ERROR
            ) from exc
        await websocket.send_json({"type": "ready"})
        answered_at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        await _converse(websocket, link, outbox)
    except RelayError as error:
        end_code = error.code
        logger.info("relay error code=%s room=%s", error.code, room)
        await _send_error(websocket, error)
    except WebSocketDisconnect:
        end_code = "disconnected"
        pass
    finally:
        if house_task is not None and not house_task.done():
            house_task.cancel()
        if link is not None:
            if start.device_key is not None and started_at is not None and answered_at is not None:
                try:
                    await write_visit(
                        settings, start.device_key, start.visit_id, start.mode,
                        chimed_at=started_at, answered_at=answered_at,
                        utterances=getattr(link, "utterances", []),
                        end_code=end_code, end_json=None,
                    )
                except Exception as exc:
                    logger.warning("visit history write failed: %s", type(exc).__name__)
            await link.aclose()
            await delete_room(room)
        logger.info("relay closed room=%s", room)
