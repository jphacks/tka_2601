import asyncio
import io
import os
import wave
from dataclasses import replace
from datetime import UTC, datetime
from dataclasses import asdict
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

TEST_API_KEY = "a" * 64
os.environ.setdefault("DOOR_API_KEY", TEST_API_KEY)

from door_backend import api


def auth_headers():
    return {"Authorization": f"Bearer {api.settings.api_key}"}


def test_status_reports_individual_service_readiness(monkeypatch):
    async def available(*args, **kwargs):
        return True

    async def livekit():
        return False

    monkeypatch.setattr(api, "_model_available", available)
    monkeypatch.setattr(api, "_llm_available", available)
    monkeypatch.setattr(api, "_livekit_available", livekit)
    result = asyncio.run(api.status())
    assert result["asr"]["ready"]
    assert result["tts"]["ready"]
    assert result["llm"]["ready"]
    assert not result["livekit"]["ready"]
    assert not result["ready"]
    assert result["test_environment"] == (api.settings.environment == "development")
    assert result["admin_settings_available"] is True


def test_local_root_serves_the_web_ui_in_development(monkeypatch):
    monkeypatch.setattr(api, "settings", replace(api.settings, environment="development"))
    with TestClient(api.app) as client:
        response = client.get("/")
        script = client.get("/assets/app.js")
        stylesheet = client.get("/assets/app.css")
    assert response.status_code == 200
    assert 'id="test-panel"' in response.text
    assert script.status_code == stylesheet.status_code == 200
    assert "/api/test/rules" in script.text
    assert 'id="save-admin-settings"' in response.text
    assert 'id="reset-admin-settings"' in response.text
    assert "history-test" in stylesheet.text


def test_connect_returns_503_when_dispatch_fails(monkeypatch):
    async def fail(_room, _rules):
        raise RuntimeError("agent worker is unavailable")

    monkeypatch.setattr(api, "_dispatch_agent", fail)
    with TestClient(api.app) as client:
        response = client.post(
            "/api/connect",
            json={"house_rules": "宅配ボックスへお願いします。"},
            headers=auth_headers(),
        )
    assert response.status_code == 503


def test_development_rules_preview_applies_selected_mode_and_settings(monkeypatch):
    monkeypatch.setattr(api, "settings", replace(api.settings, environment="development"))
    result = asyncio.run(
        api.test_rules(
            api.ConnectRequest(
                mode="away",
                away_leave_at_door=True,
                extra_instructions="犬がいるので、ドアから離れてください。",
            )
        )
    )
    assert result["mode"] == "away"
    assert "置き配の指定があればその場所に置き" in result["house_rules"]
    assert "犬がいるので、ドアから離れてください。" in result["house_rules"]


def test_connect_dispatches_admin_mode_rules_in_production(monkeypatch):
    monkeypatch.setattr(api, "settings", replace(api.settings, environment="production"))
    dispatched = {}

    async def dispatch(room, rules):
        dispatched.update(room=room, rules=rules)

    monkeypatch.setattr(api, "_dispatch_agent", dispatch)
    response = asyncio.run(
        api.connect(
            api.ConnectRequest(
                mode="away",
                away_leave_at_door=False,
                extra_instructions="呼び鈴を鳴らしたら少し待ってください。",
            )
        )
    )
    assert response.room == dispatched["room"]
    assert "不在票を入れるよう頼む" in dispatched["rules"]
    assert "呼び鈴を鳴らしたら少し待ってください。" in dispatched["rules"]


def test_admin_rules_preview_is_available_in_production(monkeypatch):
    monkeypatch.setattr(api, "settings", replace(api.settings, environment="production"))
    result = asyncio.run(api.test_rules(api.ConnectRequest(mode="away")))
    assert result["mode"] == "away"
    assert "不在票を入れるよう頼む" in result["house_rules"]


def test_development_visit_save_passes_test_device_key_and_transcript(monkeypatch):
    monkeypatch.setattr(
        api,
        "settings",
        replace(api.settings, environment="development", supabase_url="https://example.supabase.co"),
    )
    written = {}

    async def save(settings, device_key, visit_id, mode, **kwargs):
        written.update(device_key=device_key, visit_id=visit_id, mode=mode, kwargs=kwargs)
        return {"applied": True}

    monkeypatch.setattr(api, "write_visit", save)
    body = api.TestVisitRequest(
        visit_id="6d761ee0-b454-4d25-bc6c-60672dd1fa37",
        device_key="test-device-key",
        mode="away",
        chimed_at=datetime(2026, 10, 17, tzinfo=UTC),
        answered_at=datetime(2026, 10, 17, 0, 0, 1, tzinfo=UTC),
        messages=[
            api.TestVisitMessage(
                speaker="visitor", text="荷物です。", spoken_at=datetime(2026, 10, 17, 0, 0, 2, tzinfo=UTC)
            )
        ],
    )
    response = asyncio.run(api.test_save_visit(body))

    assert response == {"saved": True}
    assert written["device_key"] == "test-device-key"
    assert written["mode"] == "away"
    assert written["kwargs"]["utterances"][0]["text"] == "荷物です。"


def test_development_visit_save_is_disabled_in_production(monkeypatch):
    monkeypatch.setattr(
        api, "settings", replace(api.settings, environment="production", supabase_url="https://example.supabase.co")
    )
    body = api.TestVisitRequest(
        visit_id="6d761ee0-b454-4d25-bc6c-60672dd1fa37",
        device_key="test-device-key",
        mode="normal",
        chimed_at=datetime(2026, 10, 17, tzinfo=UTC),
        answered_at=datetime(2026, 10, 17, 0, 0, 1, tzinfo=UTC),
        messages=[],
    )
    with pytest.raises(api.HTTPException) as error:
        asyncio.run(api.test_save_visit(body))
    assert error.value.status_code == 404


def test_tts_preview_is_playable_wav(monkeypatch):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(b"\x00\x00" * 480)

    async def synthesize(_text):
        return buffer.getvalue()

    monkeypatch.setattr(api, "_synthesize_preview", synthesize)
    with TestClient(api.app) as client:
        response = client.post("/api/tts-check?scenario=thanks", headers=auth_headers())
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF"


def test_api_routes_reject_missing_or_invalid_keys(monkeypatch):
    async def should_not_run(*args, **kwargs):
        raise AssertionError("unauthenticated request reached a protected handler")

    monkeypatch.setattr(api, "_livekit_available", should_not_run)
    with TestClient(api.app) as client:
        missing = client.get("/api/status")
        invalid = client.post(
            "/api/connect",
            json={"house_rules": "hello"},
            headers={"Authorization": "Bearer invalid"},
        )
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert invalid.status_code == 401


def test_tts_preview_rejects_missing_api_key_before_synthesis(monkeypatch):
    async def should_not_run(_text):
        raise AssertionError("unauthenticated request reached TTS")

    monkeypatch.setattr(api, "_synthesize_preview", should_not_run)
    with TestClient(api.app) as client:
        response = client.post("/api/tts-check?scenario=thanks")
    assert response.status_code == 401


def test_tts_preview_rejects_oversized_upstream_audio(monkeypatch):
    values = asdict(api.settings)
    values["max_tts_response_bytes"] = 2
    monkeypatch.setattr(api, "settings", SimpleNamespace(**values))

    class Content:
        async def iter_chunked(self, _size):
            yield b"\x00\x00\x00\x00"

    class UpstreamResponse:
        status = 200
        content_type = "application/octet-stream"
        content = Content()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

    class Session:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def post(self, *_args, **_kwargs):
            return UpstreamResponse()

    monkeypatch.setattr(api.aiohttp, "ClientSession", Session)
    with TestClient(api.app) as client:
        response = client.post("/api/tts-check?scenario=thanks", headers=auth_headers())
    assert response.status_code == 502


def test_request_body_limit_rejects_chunked_body_without_content_length():
    class Downstream:
        called = False

        async def __call__(self, _scope, _receive, _send):
            self.called = True

    downstream = Downstream()
    middleware = api.RequestBodyLimitMiddleware(downstream, max_bytes=4)
    messages = iter(
        [
            {"type": "http.request", "body": b"1234", "more_body": True},
            {"type": "http.request", "body": b"5", "more_body": False},
        ]
    )
    sent = []

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    asyncio.run(
        middleware(
            {"type": "http", "path": "/api/connect", "headers": []},
            receive,
            send,
        )
    )
    assert not downstream.called
    assert sent[0]["status"] == 413


def test_capacity_limiter_bounds_queue_and_admits_after_release():
    async def scenario():
        limiter = api.CapacityLimiter(active_limit=1, queue_limit=1, wait_seconds=0.5)
        assert await limiter.acquire()
        waiter = asyncio.create_task(limiter.acquire())
        await asyncio.sleep(0)
        assert not await limiter.acquire()
        await limiter.release()
        assert await waiter
        await limiter.release()

    asyncio.run(scenario())
