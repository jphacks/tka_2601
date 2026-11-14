import asyncio
import io
import os
import wave
from dataclasses import asdict, replace
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

TEST_API_KEY = "a" * 64
os.environ.setdefault("DOOR_API_KEY", TEST_API_KEY)

from monban_backend import api


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
    assert "supabase_configured" in result


def test_on_demand_status_does_not_wake_modal_models(monkeypatch):
    async def should_not_probe(*_args, **_kwargs):
        raise AssertionError("status must not wake on-demand inference")

    async def livekit():
        return True

    monkeypatch.setattr(api, "settings", replace(api.settings, inference_on_demand=True))
    monkeypatch.setattr(api, "_model_available", should_not_probe)
    monkeypatch.setattr(api, "_llm_available", should_not_probe)
    monkeypatch.setattr(api, "_livekit_available", livekit)
    result = asyncio.run(api.status())
    assert result["inference_mode"] == "on-demand"
    assert result["asr"]["ready"] is None
    assert result["tts"]["ready"] is None
    assert result["llm"]["ready"] is None
    assert result["ready"]


def test_root_returns_api_metadata_without_serving_a_web_ui():
    with TestClient(api.app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"service": "monban-api", "docs": "/docs", "health": "/healthz"}
    assert client.get("/assets/app.js").status_code == 404


def test_production_preserves_authenticated_voice_api_endpoints(monkeypatch):
    monkeypatch.setattr(api, "settings", replace(api.settings, environment="production", allow_tailnet_http=True))
    with TestClient(api.app) as client:
        unauthorized = client.post("/api/connect", json={})
        direct_connect = client.post("/api/connect", json={}, headers=auth_headers())
        tts_check = client.post("/api/tts-check", headers=auth_headers())
    assert unauthorized.status_code == 401
    assert direct_connect.status_code == 409
    assert tts_check.status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/control/mode"),
        ("PUT", "/api/control/mode"),
        ("GET", "/api/control/sessions"),
        ("POST", "/api/test/rules"),
        ("POST", "/api/test/visits"),
        ("POST", "/api/demo/connect"),
        ("POST", "/api/demo/speech"),
        ("POST", "/api/reception/connect"),
        ("GET", "/api/reception/settings"),
        ("POST", "/api/integrations/google-calendar/start"),
        ("POST", "/api/v1/auth/login"),
        ("GET", "/oauth/google/callback"),
        ("GET", "/env-config.js"),
    ],
)
def test_demo_account_and_google_routes_are_gone(method, path):
    with TestClient(api.app) as client:
        response = client.request(method, path, headers=auth_headers(), json={})
    assert response.status_code in {404, 405}


def test_connect_returns_503_when_dispatch_fails(monkeypatch):
    async def fail(_room, _rules, _reception=None):
        raise RuntimeError("agent worker is unavailable")

    monkeypatch.setattr(api, "_dispatch_agent", fail)
    with TestClient(api.app) as client:
        response = client.post(
            "/api/connect",
            json={"house_rules": "宅配ボックスへお願いします。"},
            headers=auth_headers(),
        )
    assert response.status_code == 503


def test_connect_uses_the_device_settings_from_supabase(monkeypatch):
    from monban_backend.core.house_rules import HouseSettings
    from monban_backend.persistence.device_api import DeviceSettings, ShopProfile

    monkeypatch.setattr(api, "settings", replace(api.settings, environment="development"))
    dispatched = []
    devices = {
        "home-key": DeviceSettings(HouseSettings(extra_instructions="呼び鈴を鳴らしたら少し待ってください。")),
        "shop-key": DeviceSettings(HouseSettings(), shop=ShopProfile(name="ネイルサロン架空")),
    }

    async def fetch(device_key):
        return devices.get(device_key)

    async def dispatch(room, rules, reception=None):
        dispatched.append((room, rules, reception))

    monkeypatch.setattr(api, "fetch_device_settings", fetch)
    monkeypatch.setattr(api, "_dispatch_agent", dispatch)
    home = asyncio.run(api.connect(api.ConnectRequest(device_key="home-key", mode="away")))
    assert home.room == dispatched[0][0]
    assert "不在票を入れるよう頼む" in dispatched[0][1]
    assert "呼び鈴を鳴らしたら少し待ってください。" in dispatched[0][1]
    assert dispatched[0][2] is None

    asyncio.run(api.connect(api.ConnectRequest(device_key="shop-key")))
    assert dispatched[1][2] == {"device_key": "shop-key", "shop": devices["shop-key"].shop.to_json()}

    with pytest.raises(api.HTTPException) as error:
        asyncio.run(api.connect(api.ConnectRequest(device_key="unknown-key")))
    assert error.value.status_code == 502


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


@pytest.mark.parametrize(
    ("path", "heading"),
    [("/about", "<h1>Monban</h1>"), ("/privacy", "<h1>プライバシーポリシー</h1>"), ("/terms", "<h1>利用規約</h1>")],
)
def test_public_pages_for_the_google_consent_screen(monkeypatch, path, heading):
    # The consent screen links here, so the pages are public even in production.
    monkeypatch.setattr(api, "settings", replace(api.settings, environment="production"))
    with TestClient(api.app) as client:
        response = client.get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert heading in response.text
    assert "<script" not in response.text
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    if path == "/privacy":
        assert "限定使用" in response.text
        assert "calendar.events" in response.text
    assert path not in api.app.openapi()["paths"]
