import asyncio
from dataclasses import asdict
from types import SimpleNamespace
from uuid import uuid4

import pytest
from aiohttp import web
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from door_backend import api, relay
from door_backend.house_rules import (
    DELIVERY_AWAY_LEAVE_AT_DOOR,
    EXTRA_HEAD,
    HouseSettings,
    base_rules,
)

DEVICE_KEY = "device-key-for-tests"


def auth_headers():
    return {"Authorization": f"Bearer {api.settings.api_key}"}


def start_message(mode="omakase"):
    return {"type": "start", "visit_id": str(uuid4()), "mode": mode, "device_key": DEVICE_KEY}


class FakeLink:
    """Stands in for the LiveKit room. Tests push agent output through push()."""

    def __init__(self, outbox):
        self.outbox = outbox
        self.loop = asyncio.get_running_loop()
        self.audio = []
        self.closed = False

    async def send_audio(self, pcm):
        self.audio.append(pcm)

    async def aclose(self):
        self.closed = True

    def push(self, item):
        self.loop.call_soon_threadsafe(self.outbox.put_nowait, item)


@pytest.fixture
def livekit(monkeypatch):
    calls = SimpleNamespace(links=[], dispatched=[], deleted=[], settings_keys=[], house=HouseSettings())

    async def connect_agent_room(room, identity, outbox):
        link = FakeLink(outbox)
        calls.links.append(link)
        return link

    async def dispatch(room, house_rules):
        calls.dispatched.append((room, house_rules))

    async def delete_room(room):
        calls.deleted.append(room)

    async def fetch_house_settings(device_key):
        calls.settings_keys.append(device_key)
        return calls.house

    monkeypatch.setattr(relay, "connect_agent_room", connect_agent_room)
    monkeypatch.setattr(relay, "delete_room", delete_room)
    monkeypatch.setattr(relay, "fetch_house_settings", fetch_house_settings)
    monkeypatch.setattr(api, "_dispatch_agent", dispatch)
    return calls


def test_relay_rejects_missing_or_invalid_key(livekit):
    with TestClient(api.app) as client:
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            with pytest.raises(WebSocketDisconnect) as closed:
                with client.websocket_connect("/api/relay", headers=headers):
                    pass
            assert closed.value.code == relay.CLOSE_POLICY
    assert not livekit.links


def test_relay_conversation_round_trip(livekit):
    livekit.house = HouseSettings(away_leave_at_door=True, extra_instructions="宗教の勧誘も断ってください。")
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start_message("away"))
            assert ws.receive_json() == {"type": "ready"}

            room, rules = livekit.dispatched[0]
            assert livekit.settings_keys == [DEVICE_KEY]
            assert rules.startswith(base_rules("away", True))
            assert DELIVERY_AWAY_LEAVE_AT_DOOR in rules
            assert rules.endswith(f"{EXTRA_HEAD}\n宗教の勧誘も断ってください。")

            link = livekit.links[0]
            ws.send_bytes(b"\x01\x00" * 320)
            link.push(("json", {"type": "agent_state", "state": "speaking"}))
            assert ws.receive_json() == {"type": "agent_state", "state": "speaking"}
            link.push(("audio", b"\x02\x00" * 320))
            assert ws.receive_bytes() == b"\x02\x00" * 320
            link.push(("json", {"type": "transcript", "speaker": "ai", "text": "はい、どちら様でしょうか。"}))
            assert ws.receive_json()["text"] == "はい、どちら様でしょうか。"

            ws.send_json({"type": "end"})
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == relay.CLOSE_NORMAL
    assert link.audio == [b"\x01\x00" * 320]
    assert link.closed
    assert livekit.deleted == [room]


def test_relay_continues_without_house_settings(livekit):
    livekit.house = None
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start_message("normal"))
            assert ws.receive_json() == {"type": "ready"}
            ws.send_json({"type": "end"})
    assert livekit.dispatched[0][1] == base_rules("normal")


@pytest.mark.parametrize(
    "start",
    [
        {**start_message(), "mode": "off"},
        {key: value for key, value in start_message().items() if key != "mode"},
        {**start_message(), "visit_id": "not-a-uuid"},
        {**start_message(), "device_key": ""},
        {**start_message(), "device_key": "key with spaces"},
    ],
)
def test_relay_rejects_invalid_start(livekit, start):
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start)
            assert ws.receive_json()["code"] == "invalid_start"
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == relay.CLOSE_POLICY
    assert not livekit.links and not livekit.dispatched


def test_relay_times_out_without_start(livekit, monkeypatch):
    values = asdict(relay.settings)
    values["relay_start_timeout_seconds"] = 0.05
    monkeypatch.setattr(relay, "settings", SimpleNamespace(**values))
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            assert ws.receive_json()["code"] == "start_timeout"
    assert not livekit.links


def test_relay_reports_agent_dispatch_failure(livekit, monkeypatch):
    async def fail(_room, _rules):
        raise RuntimeError("agent worker is unavailable")

    monkeypatch.setattr(api, "_dispatch_agent", fail)
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start_message())
            assert ws.receive_json()["code"] == "agent_unavailable"
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == relay.CLOSE_SERVER_ERROR
    assert livekit.links[0].closed


@pytest.mark.parametrize("pcm", [b"\x00", b"\x00" * (relay.MAX_AUDIO_MESSAGE_BYTES + 2)])
def test_relay_rejects_invalid_audio(livekit, pcm):
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start_message())
            ws.receive_json()
            ws.send_bytes(pcm)
            assert ws.receive_json()["code"] == "invalid_audio"
    assert livekit.links[0].audio == []


def test_relay_reports_livekit_disconnect(livekit):
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start_message())
            ws.receive_json()
            livekit.links[0].push(("closed", "livekit_disconnected"))
            assert ws.receive_json()["code"] == "livekit_disconnected"
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == relay.CLOSE_SERVER_ERROR


def test_relay_limits_concurrent_sessions(livekit, monkeypatch):
    values = asdict(api.settings)
    values["max_relay_sessions"] = 1
    monkeypatch.setattr(api, "settings", SimpleNamespace(**values))
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as first:
            first.send_json(start_message())
            first.receive_json()
            with client.websocket_connect("/api/relay", headers=auth_headers()) as second:
                assert second.receive_json()["code"] == "busy"
            first.send_json({"type": "end"})


# LiveKit side of the relay, without a LiveKit server


class FakeReader:
    def __init__(self, text, attributes):
        self.info = SimpleNamespace(attributes=attributes)
        self._text = text

    async def read_all(self):
        return self._text


def bare_link():
    link = relay.LiveKitLink.__new__(relay.LiveKitLink)
    link._outbox = asyncio.Queue()
    link._room = SimpleNamespace(local_participant=SimpleNamespace(identity="visitor-1"))
    link._track_sid = "TR_visitor"
    link._agent_speaking = False
    link._tasks = set()
    return link


def drain(queue):
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


def test_transcripts_are_final_and_labelled_by_speaker():
    final, interim = {"lk.transcription_final": "true"}, {"lk.transcription_final": "false"}

    async def scenario():
        link = bare_link()
        await link._forward_transcript(FakeReader("ヤマト運輸です", interim), "visitor-1")
        await link._forward_transcript(FakeReader("ヤマト運輸です。", final), "visitor-1")
        await link._forward_transcript(
            FakeReader("お届けです。", {**final, "lk.transcribed_track_id": "TR_visitor"}), "agent-1"
        )
        await link._forward_transcript(FakeReader("恐れ入りますが、", interim), "agent-1")
        await link._forward_transcript(FakeReader("  ", final), "agent-1")
        return drain(link._outbox)

    assert asyncio.run(scenario()) == [
        ("json", {"type": "transcript", "speaker": "visitor", "text": "ヤマト運輸です。"}),
        ("json", {"type": "transcript", "speaker": "visitor", "text": "お届けです。"}),
        ("json", {"type": "transcript", "speaker": "ai", "text": "恐れ入りますが、"}),
    ]


def test_agent_states_are_forwarded_and_gate_silence(monkeypatch):
    from livekit import rtc

    agent = SimpleNamespace(kind=rtc.ParticipantKind.PARTICIPANT_KIND_AGENT)
    visitor = SimpleNamespace(kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)
    silence, voice = bytes(relay.FRAME_BYTES), b"\x10\x00" * (relay.FRAME_BYTES // 2)
    frames = []

    class FakeStream:
        def __init__(self, *_args, **_kwargs):
            self._frames = iter(list(frames))

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return SimpleNamespace(frame=SimpleNamespace(data=next(self._frames)))
            except StopIteration:
                raise StopAsyncIteration

        async def aclose(self):
            pass

    monkeypatch.setattr(relay.rtc, "AudioStream", FakeStream)

    async def scenario():
        link = bare_link()
        link._on_attributes_changed({"lk.agent.state": "initializing"}, agent)
        link._on_attributes_changed({"lk.agent.state": "speaking"}, visitor)
        frames[:] = [silence, voice]
        await link._forward_agent_audio(None)
        link._on_attributes_changed({"lk.agent.state": "speaking"}, agent)
        frames[:] = [silence]
        await link._forward_agent_audio(None)
        return drain(link._outbox)

    assert asyncio.run(scenario()) == [
        ("audio", voice),
        ("json", {"type": "agent_state", "state": "speaking"}),
        ("audio", silence),
    ]


# Reading the house settings from the Supabase Edge Function


def run_with_settings_server(handler, scenario, monkeypatch, **overrides):
    async def main():
        app = web.Application()
        app.router.add_get("/functions/v1/device/settings", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        values = asdict(relay.settings)
        values.update(supabase_url=f"http://127.0.0.1:{port}", supabase_anon_key="test-public-api-key", house_settings_timeout_seconds=0.5)
        values.update(overrides)
        monkeypatch.setattr(relay, "settings", SimpleNamespace(**values))
        try:
            return await scenario()
        finally:
            await runner.cleanup()

    return asyncio.run(main())


def test_house_settings_are_read_with_the_device_key(monkeypatch):
    seen = {}

    async def handler(request):
        seen["authorization"] = request.headers.get("Authorization")
        seen["apikey"] = request.headers.get("apikey")
        # The Edge Function also returns fields the relay does not use (supabase/README.md).
        return web.json_response(
            {
                "paired": True,
                "mode": "normal",
                "away_leave_at_door": True,
                "auto_away": False,
                "extra_instructions": "犬がいます。",
            }
        )

    result = run_with_settings_server(
        handler, lambda: relay.fetch_house_settings(DEVICE_KEY), monkeypatch
    )
    assert result == HouseSettings(away_leave_at_door=True, extra_instructions="犬がいます。")
    assert seen["authorization"] == f"Bearer {DEVICE_KEY}"
    assert seen["apikey"] == "test-public-api-key"


@pytest.mark.parametrize(
    "response",
    [
        web.json_response({"error": "unauthorized"}, status=401),
        web.json_response({"away_leave_at_door": "yes", "extra_instructions": ""}),
        web.json_response(["not", "an", "object"]),
        web.Response(text="not json"),
        web.Response(body=b" " * (relay.MAX_SETTINGS_RESPONSE_BYTES + 1), content_type="application/json"),
    ],
)
def test_house_settings_failures_mean_no_settings(monkeypatch, response):
    async def handler(_request):
        return response

    assert run_with_settings_server(handler, lambda: relay.fetch_house_settings(DEVICE_KEY), monkeypatch) is None


def test_house_settings_give_up_after_the_timeout(monkeypatch):
    async def handler(_request):
        await asyncio.sleep(1)
        return web.json_response({"away_leave_at_door": False, "extra_instructions": ""})

    async def scenario():
        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await relay.fetch_house_settings(DEVICE_KEY)
        return result, loop.time() - started

    result, elapsed = run_with_settings_server(handler, scenario, monkeypatch, house_settings_timeout_seconds=0.1)
    assert result is None
    assert elapsed < 0.5


def test_house_settings_are_skipped_without_supabase_url(monkeypatch):
    values = asdict(relay.settings)
    values["supabase_url"] = ""
    monkeypatch.setattr(relay, "settings", SimpleNamespace(**values))
    assert asyncio.run(relay.fetch_house_settings(DEVICE_KEY)) is None


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("{", "テキストのメッセージは JSON にしてください。"),
        ("[]", "テキストのメッセージは JSON のオブジェクトにしてください。"),
    ],
)
def test_invalid_control_preserves_wire_error_and_closes_link(livekit, text, message):
    with TestClient(api.app) as client:
        with client.websocket_connect("/api/relay", headers=auth_headers()) as ws:
            ws.send_json(start_message())
            assert ws.receive_json() == {"type": "ready"}
            ws.send_text(text)
            assert ws.receive_json() == {
                "type": "error", "code": "invalid_message", "message": message,
            }
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 1008
    assert livekit.links[0].closed
    assert len(livekit.deleted) == 1
