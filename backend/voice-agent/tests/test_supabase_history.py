import asyncio

from door_backend.supabase_history import build_visit_payload, visit_messages
from door_backend import supabase_history
from door_backend.config import settings
from dataclasses import replace
from uuid import uuid4


def test_visit_messages_keeps_valid_transcripts_and_numbers_arrival_order():
    messages = visit_messages([
        {"speaker": "visitor", "text": "  荷物です  ", "spoken_at": "2026-10-17T00:00:00Z"},
        {"speaker": "system", "text": "discard"},
        {"speaker": "ai", "text": "玄関前にお願いします。", "spoken_at": "2026-10-17T00:00:01Z"},
    ])
    assert messages == [
        {"seq": 1, "speaker": "visitor", "text": "  荷物です  ", "spoken_at": "2026-10-17T00:00:00Z"},
        {"seq": 3, "speaker": "ai", "text": "玄関前にお願いします。", "spoken_at": "2026-10-17T00:00:01Z"},
    ]


def test_payload_has_device_api_fields_and_sanitizes_unknown_values():
    payload = build_visit_payload(
        "normal", "2026-10-17T00:00:00Z", "2026-10-17T00:00:01Z",
        "2026-10-17T00:00:12Z", [],
        {"intent": "malicious", "outcome": "none", "company": " A "},
    )
    assert payload == {
        "chimed_at": "2026-10-17T00:00:00Z",
        "mode": "normal",
        "status": "ended",
        "answered_at": "2026-10-17T00:00:01Z",
        "ended_at": "2026-10-17T00:00:12Z",
        "messages": [],
        "outcome": "none",
        "company": "A",
    }


def test_put_visit_uses_device_edge_function_and_bearer_key(monkeypatch):
    seen = {}

    class Response:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def json(self, content_type=None):
            return {"applied": True}

    class Session:
        def __init__(self, timeout):
            seen["timeout"] = timeout.total

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        def put(self, url, *, json, headers):
            seen.update(url=url, body=json, headers=headers)
            return Response()

    monkeypatch.setattr(supabase_history.aiohttp, "ClientSession", Session)
    result = asyncio.run(
        supabase_history.put_visit(replace(settings, supabase_url="https://test-project.supabase.co", supabase_anon_key="test-public-api-key"), "device-secret", uuid4(), {"status": "ended"})
    )

    assert result == {"applied": True}
    assert seen["url"].startswith("https://test-project.supabase.co/functions/v1/device/visits/")
    assert seen["headers"] == {"apikey": "test-public-api-key", "Authorization": "Bearer device-secret"}
    assert seen["body"] == {"status": "ended"}
    assert seen["timeout"] == settings.visit_write_timeout_seconds


def test_put_visit_returns_none_on_edge_function_error(monkeypatch):
    class Response:
        status = 503

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

    class Session:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        def put(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(supabase_history.aiohttp, "ClientSession", Session)
    result = asyncio.run(
        supabase_history.put_visit(replace(settings, supabase_url="https://test-project.supabase.co", supabase_anon_key="test-public-api-key"), "device-secret", uuid4(), {"status": "ended"})
    )

    assert result is None
