"""The existing DoorAgent with a device-controlled, acknowledged audio sink.

V2 runs the same LiveKit Agents pipeline in the API process, without an RTC room.
Input is recognized as one bounded utterance after the device's explicit boundary;
there is deliberately no VAD stream that could split that utterance a second time.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from livekit import rtc
from livekit.agents import APIConnectOptions, AgentSession
from livekit.agents.voice import io
from livekit.agents.voice.agent_session import SessionConnectOptions

from .config import settings


class DeviceAudioOutput(io.AudioOutput):
    def __init__(self, write: Callable[[bytes], Awaitable[None]], finish: Callable[[], Awaitable[None]]):
        super().__init__(label="relay-device", capabilities=io.AudioOutputCapabilities(pause=False), sample_rate=16000)
        self._write = write
        self._finish = finish
        self._pending = bytearray()
        self._samples = 0
        self._flushed = False
        self._closed = False
        self.finish_task: asyncio.Task | None = None
        self.failure: Exception | None = None

    def begin(self) -> None:
        if self._closed:
            raise RuntimeError("audio output is closed")
        if self._pending_playback_count:
            raise RuntimeError("previous output is still playing")
        self._pending.clear()
        self._samples = 0
        self._flushed = False
        self.finish_task = None
        self.failure = None

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        if self._closed:
            raise RuntimeError("audio output is closed")
        if self._flushed:
            raise RuntimeError("multiple SDK output segments in one device reply are unsupported")
        if frame.sample_rate != 16000 or frame.num_channels != 1:
            raise ValueError("unexpected SDK audio format")
        await super().capture_frame(frame)
        if not self._samples:
            self.on_playback_started(created_at=time.time())
        self._samples += frame.samples_per_channel
        self._pending.extend(bytes(frame.data))
        try:
            while len(self._pending) >= 640:
                pcm = bytes(self._pending[:640])
                del self._pending[:640]
                await self._write(pcm)
        except Exception as exc:
            self.failure = exc
            self.clear_buffer()
            raise

    def _mark_input_truncated(self) -> None:
        # LiveKit calls this when TTS fails after producing only part of a reply.
        self.failure = RuntimeError("agent audio generation was truncated")
        self.clear_buffer()

    def flush(self) -> None:
        super().flush()
        if self._flushed or self._closed:
            return
        self._flushed = True
        if self.failure is not None:
            return
        if not self._samples:
            return

        async def finish() -> None:
            try:
                if self._pending:
                    await self._write(bytes(self._pending))
                    self._pending.clear()
                await self._finish()
            except Exception as exc:
                self.failure = exc
                self.clear_buffer()

        # SDK flush is synchronous. capture_frame awaits every prior write, so this
        # task follows all PCM. The SDK itself now waits for actual device playout.
        self.finish_task = asyncio.create_task(finish())

    def played(self) -> None:
        if not self._flushed or not self._samples:
            raise RuntimeError("playout cannot finish before audio flush")
        while self._pending_playback_count:
            self.on_playback_finished(playback_position=self._samples / 16000, interrupted=False)

    def clear_buffer(self) -> None:
        self._pending.clear()
        super().flush()
        while self._pending_playback_count:
            self.on_playback_finished(playback_position=0, interrupted=True)

    async def aclose(self) -> None:
        self._closed = True
        if self.finish_task and not self.finish_task.done():
            self.finish_task.cancel()
            await asyncio.gather(self.finish_task, return_exceptions=True)
        self.clear_buffer()


class DeviceAgent:
    """Adapter around the same DoorAgent, STT, LLM and TTS used by the RTC worker."""
    def __init__(self, house_rules: str, write, finish, transcript):
        # Lazy import keeps v1 and tests independent of the v2 model clients.
        from .agent import DoorAgent, _llm, _stt
        from .speech_tts import SpeechCppTTS

        self.agent = DoorAgent(house_rules)
        self.stt = _stt()
        self.llm = _llm()
        self.tts = SpeechCppTTS()
        self.output = DeviceAudioOutput(write, finish)
        self.session = AgentSession(
            llm=self.llm, tts=self.tts, stt=None, vad=None,
            turn_detection="manual", allow_interruptions=False,
            user_away_timeout=None,
            conn_options=SessionConnectOptions(llm_conn_options=APIConnectOptions(
                max_retry=1, retry_interval=1, timeout=settings.llm_timeout_seconds,
            )),
        )
        self.session.output.audio = self.output
        self._transcript = transcript
        self._text_tasks: set[asyncio.Task] = set()

        @self.session.on("conversation_item_added")
        def on_item(event: Any) -> None:
            item = event.item
            if item.type == "message" and item.role == "assistant" and item.text_content:
                task = asyncio.create_task(self._transcript("ai", item.text_content))
                self._text_tasks.add(task)
                task.add_done_callback(self._text_tasks.discard)

    async def start(self) -> None:
        await self.session.start(agent=self.agent)

    async def recognize(self, pcm: bytes) -> str:
        result = await self.stt.recognize(
            rtc.AudioFrame(pcm, 16000, 1, len(pcm) // 2),
            conn_options=APIConnectOptions(max_retry=1, retry_interval=1, timeout=45),
        )
        text = result.alternatives[0].text.strip() if result.alternatives else ""
        if text:
            await self._transcript("visitor", text)
        return text

    async def reply(self, text: str | None) -> None:
        self.output.begin()
        if text is None:
            handle = self.session.say("はい、どちら様でしょうか。", allow_interruptions=False)
        else:
            handle = self.session.generate_reply(user_input=text, allow_interruptions=False, input_modality="audio")
        await handle
        if self.output.finish_task:
            await self.output.finish_task
        if self.output.failure:
            raise self.output.failure
        if handle.exception():
            raise handle.exception()
        # ConversationItemAdded is emitted before SpeechHandle completes. Persist
        # the resulting text before announcing the next turn/closing the visit.
        if self._text_tasks:
            await asyncio.gather(*self._text_tasks)

    def end_after_reply(self) -> bool:
        # DoorAgent records this only for its validated, final full response.
        return self.agent.last_reply_ends_call

    def played(self) -> None:
        self.output.played()

    async def aclose(self) -> None:
        await self.output.aclose()
        await self.session.aclose()
        await asyncio.gather(self.stt.aclose(), self.llm.aclose(), self.tts.aclose(), return_exceptions=True)
        if self._text_tasks:
            await asyncio.gather(*self._text_tasks, return_exceptions=True)
