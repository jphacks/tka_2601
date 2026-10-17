"""Exercise real LiveKit scheduling/playout with entirely local model doubles."""
import asyncio
import pytest
from livekit import rtc
from livekit.agents import Agent, AgentSession, TurnHandlingOptions, llm, tts

from door_backend.relay_agent import DeviceAgent, DeviceAudioOutput


class LocalLLM(llm.LLM):
    def chat(self, **kwargs):
        raise AssertionError("test must not call an LLM service")


class LocalTTS(tts.TTS):
    def __init__(self):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=16000,
            num_channels=1,
        )

    def synthesize(self, *args, **kwargs):
        raise AssertionError("test must not call a TTS service")


class LocalAgent(Agent):
    def __init__(self, house_rules="test", *, silent=False):
        super().__init__(instructions=house_rules)
        self.silent = silent
        self.seen_contexts = []
        self.text_chunks = []
        self.last_reply_ends_call = False

    async def llm_node(self, chat_ctx, tools, model_settings):
        self.seen_contexts.append([
            (item.role, item.text_content)
            for item in chat_ctx.items if item.type == "message"
        ])
        if not self.silent:
            yield "First sentence."
            yield " Second sentence."

    async def tts_node(self, text, model_settings):
        async for chunk in text:
            if not isinstance(chunk, str) or not chunk:
                continue
            self.text_chunks.append(chunk)
            # Frames straddle the device's 320-sample packet boundary and include
            # a tail that must be delivered before output_end.
            for samples in (160, 320, 17):
                yield rtc.AudioFrame(b"\x01\x00" * samples, 16000, 1, samples)


def make_session(output, agent):
    session = AgentSession(
        llm=LocalLLM(), tts=LocalTTS(), use_tts_aligned_transcript=False,
        turn_handling=TurnHandlingOptions(
            turn_detection="manual",
            interruption={"enabled": False, "resume_false_interruption": False},
            preemptive_generation={"enabled": False},
        ),
        user_away_timeout=None,
    )
    session.output.audio = output
    return session


def test_real_sdk_finishes_whole_reply_only_after_device_playback():
    async def run():
        messages = []
        ended = asyncio.Event()

        async def write(pcm):
            messages.append(pcm)

        async def finish():
            messages.append("output_end")
            ended.set()

        output = DeviceAudioOutput(write, finish)
        agent = LocalAgent()
        session = make_session(output, agent)
        try:
            await session.start(agent, record=False)
            output.begin()
            speech = session.generate_reply(user_input="visitor one", allow_interruptions=False)
            await asyncio.wait_for(ended.wait(), 3)
            assert len(agent.text_chunks) >= 2
            assert messages.count("output_end") == 1
            assert messages[-1] == "output_end"
            packets = messages[:-1]
            assert all(len(pcm) == 640 for pcm in packets[:-1])
            assert 0 < len(packets[-1]) <= 640
            assert b"".join(packets) == b"\x01\x00" * (497 * len(agent.text_chunks))
            assert not speech.done()
            with pytest.raises(RuntimeError, match="still playing"):
                output.begin()
            output.played()
            await asyncio.wait_for(speech.wait_for_playout(), 3)
            assert speech.exception() is None

            # The second turn retains both earlier user and assistant messages.
            ended.clear()
            messages.clear()
            output.begin()
            second = session.generate_reply(user_input="visitor two", allow_interruptions=False)
            await asyncio.wait_for(ended.wait(), 3)
            assert not second.done()
            context = agent.seen_contexts[-1]
            assert ("user", "visitor one") in context
            assert ("user", "visitor two") in context
            assert any(role == "assistant" and "First sentence" in text for role, text in context)
            output.played()
            await asyncio.wait_for(second.wait_for_playout(), 3)
            assert second.exception() is None
        finally:
            await output.aclose()
            await session.aclose()

    asyncio.run(run())


def test_real_sdk_no_reply_needs_no_playback_ack():
    async def run():
        async def unexpected(*args):
            raise AssertionError("no-reply turn must not emit audio or output_end")

        output = DeviceAudioOutput(unexpected, unexpected)
        agent = LocalAgent(silent=True)
        session = make_session(output, agent)
        try:
            await session.start(agent, record=False)
            output.begin()
            speech = session.generate_reply(user_input="wait", allow_interruptions=False)
            await asyncio.wait_for(speech.wait_for_playout(), 3)
            assert speech.exception() is None
            assert output.finish_task is None
            output.begin()  # No phantom pending audio blocks the next turn.
        finally:
            await output.aclose()
            await session.aclose()

    asyncio.run(run())


def test_close_unblocks_real_sdk_waiting_for_remote_playback():
    async def run():
        ended = asyncio.Event()

        async def write(pcm):
            pass

        async def finish():
            ended.set()
            await asyncio.Event().wait()

        output = DeviceAudioOutput(write, finish)
        agent = LocalAgent()
        session = make_session(output, agent)
        try:
            await session.start(agent, record=False)
            output.begin()
            speech = session.generate_reply(user_input="hello", allow_interruptions=False)
            await asyncio.wait_for(ended.wait(), 3)
            assert not speech.done()
            await asyncio.wait_for(output.aclose(), 3)
            assert output.finish_task.done()
            await asyncio.wait_for(session.aclose(), 3)
            assert speech.done()
        finally:
            await output.aclose()
            await session.aclose()

    asyncio.run(run())


def patch_device_models(monkeypatch, agent_type=LocalAgent):
    from door_backend import agent, speech_tts

    class LocalSTT:
        async def aclose(self):
            pass

    monkeypatch.setattr(agent, "DoorAgent", agent_type)
    monkeypatch.setattr(agent, "_llm", LocalLLM)
    monkeypatch.setattr(agent, "_stt", LocalSTT)
    monkeypatch.setattr(speech_tts, "SpeechCppTTS", LocalTTS)


def test_device_agent_propagates_audio_write_failure(monkeypatch):
    patch_device_models(monkeypatch)

    async def run():
        async def write(pcm):
            raise RuntimeError("device connection failed")

        async def finish():
            pass

        async def transcript(*args):
            pass

        runtime = DeviceAgent("test", write, finish, transcript)
        try:
            await runtime.start()
            with pytest.raises(RuntimeError, match="device connection failed"):
                await asyncio.wait_for(runtime.reply("hello"), 3)
        finally:
            await runtime.aclose()

    asyncio.run(run())


def test_failed_full_packet_is_not_announced_as_complete_reply(monkeypatch):
    class OnePacketAgent(LocalAgent):
        async def tts_node(self, text, model_settings):
            async for _ in text:
                pass
            yield rtc.AudioFrame(b"\x01\x00" * 320, 16000, 1, 320)

    patch_device_models(monkeypatch, OnePacketAgent)

    async def run():
        finishes = []

        async def write(pcm):
            raise RuntimeError("device connection failed")

        async def finish():
            finishes.append(True)
            # A buggy sink may announce a failed packet as a completed response;
            # unblock it so the assertion exposes that error instead of hanging.
            runtime.played()

        async def transcript(*args):
            pass

        runtime = DeviceAgent("test", write, finish, transcript)
        try:
            await runtime.start()
            with pytest.raises(RuntimeError, match="device connection failed"):
                await asyncio.wait_for(runtime.reply("hello"), 3)
            assert not finishes
        finally:
            await runtime.aclose()

    asyncio.run(run())


def test_partial_tts_failure_cannot_finish_as_a_normal_response(monkeypatch):
    class BrokenTTSAgent(LocalAgent):
        async def tts_node(self, text, model_settings):
            async for _ in text:
                pass
            yield rtc.AudioFrame(b"\x01\x00" * 320, 16000, 1, 320)
            raise RuntimeError("test TTS failed after first packet")

    patch_device_models(monkeypatch, BrokenTTSAgent)

    async def run():
        packets, finishes = [], []

        async def write(pcm):
            packets.append(pcm)

        async def finish():
            finishes.append(True)
            runtime.played()

        async def transcript(*args):
            pass

        runtime = DeviceAgent("test", write, finish, transcript)
        try:
            await runtime.start()
            with pytest.raises(RuntimeError, match="truncated|TTS failed"):
                await asyncio.wait_for(runtime.reply("hello"), 3)
            assert packets == [b"\x01\x00" * 320]
            assert not finishes
        finally:
            await runtime.aclose()

    asyncio.run(run())


def test_cancel_during_audio_write_does_not_emit_late_output_end():
    async def run():
        writing = asyncio.Event()
        finishes = []

        async def write(pcm):
            writing.set()
            await asyncio.Event().wait()

        async def finish():
            finishes.append(True)

        output = DeviceAudioOutput(write, finish)
        agent = LocalAgent()
        session = make_session(output, agent)
        try:
            await session.start(agent, record=False)
            output.begin()
            session.generate_reply(user_input="hello", allow_interruptions=False)
            await asyncio.wait_for(writing.wait(), 3)
            await output.aclose()
            await asyncio.wait_for(session.aclose(), 3)
            await asyncio.sleep(0)
            assert not finishes
            assert output.finish_task is None or output.finish_task.done()
        finally:
            await output.aclose()
            await session.aclose()

    asyncio.run(run())
