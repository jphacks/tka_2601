"""Writes one visit and its conversation to Supabase through the Edge Function device API.

The relay holds no secret key and no service role; it calls the same device endpoint the
resident's device uses, authenticated with the device key from the start message. Text only;
audio and images are never stored. Any failure is logged and never reaches the conversation.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import aiohttp

from .config import Settings

logger = logging.getLogger("door-history")

MAX_COMPANY_CHARS = 100
MODES = {"normal", "omakase", "away", "off"}
STATUS = "ended"  # Only written once the conversation reached ready and then finished.
END_REASONS = {"closing", "silence", "time_limit", "fallback", "safe", "mode_off", "resident", "no_answer"}
INTENTS = {"delivery", "sales", "service", "emergency", "unknown"}
OUTCOMES = {"leave_at_door", "delivery_slip", "declined", "callback", "escalated", "none"}
SPEAKERS = {"visitor", "ai"}


def utc_now_iso() -> str:
    """Current time as ISO-8601 with the Z designator, as the device API requires."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _checked_company(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    return raw.strip()[:MAX_COMPANY_CHARS] or None


def _checked_choice(key: str, raw: Any, allowed: set[str]) -> str | None:
    """Accept a listed value; drop unknown or malformed ones instead of sending them."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str) and raw in allowed:
        return raw
    logger.warning("visit history field is unknown and is dropped: %s", key)
    return None


def visit_messages(utterances: list[Any]) -> list[dict[str, Any]]:
    """Number the utterances by arrival and keep only valid transcripts."""
    messages: list[dict[str, Any]] = []
    for index, raw in enumerate(utterances, start=1):
        if not isinstance(raw, dict):
            continue
        speaker, text = raw.get("speaker"), raw.get("text")
        if speaker not in SPEAKERS or not (isinstance(text, str) and text.strip()):
            continue
        messages.append(
            {"seq": index, "speaker": speaker, "text": text, "spoken_at": raw.get("spoken_at")}
        )
    return messages


def build_visit_payload(
    mode: str,
    chimed_at: str,
    answered_at: str,
    ended_at: str,
    utterances: list[Any],
    end_json: Any = None,
    end_code: str | None = None,
) -> dict[str, Any]:
    """Assemble the PUT body from the start, the collected utterances and how it ended."""
    end = end_json if isinstance(end_json, dict) else {}
    payload: dict[str, Any] = {
        "chimed_at": chimed_at,
        "mode": mode if mode in MODES else "normal",
        "status": STATUS,
        "answered_at": answered_at,
        "ended_at": ended_at,
        "messages": visit_messages(utterances),
    }
    if end_code == "time_limit":
        payload["end_reason"] = "time_limit"
    elif end_code not in (None, "end"):
        payload["end_reason"] = "safe"
    else:
        reason = _checked_choice("end_reason", end.get("end_reason"), END_REASONS)
        if reason is not None:
            payload["end_reason"] = reason
    for key, allowed in (("intent", INTENTS), ("outcome", OUTCOMES)):
        value = _checked_choice(key, end.get(key), allowed)
        if value is not None:
            payload[key] = value
    company = _checked_company(end.get("company"))
    if company is not None:
        payload["company"] = company
    return payload


async def put_visit(
    supabase_settings: Settings, device_key: str, visit_id: UUID, payload: dict[str, Any]
) -> dict[str, Any] | None:
    """PUT one visit to the device API; return the response or None. Never raises."""
    url = f"{supabase_settings.supabase_url}/functions/v1/device/visits/{visit_id}"
    timeout = aiohttp.ClientTimeout(total=supabase_settings.visit_write_timeout_seconds)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.put(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {device_key}"},
            ) as response:
                if response.status != 200:
                    logger.warning("visit history PUT failed: status=%s", response.status)
                    return None
                return await response.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
        logger.warning("visit history PUT failed: %s", type(exc).__name__)
        return None


async def write_visit(
    supabase_settings: Settings,
    device_key: str,
    visit_id: UUID,
    mode: str,
    *,
    chimed_at: str,
    answered_at: str,
    utterances: list[Any],
    end_code: str | None,
    end_json: Any,
) -> dict[str, Any] | None:
    """Build and send the single PUT that records one finished conversation."""
    payload = build_visit_payload(
        mode, chimed_at, answered_at, utc_now_iso(), utterances, end_json, end_code
    )
    return await put_visit(supabase_settings, device_key, visit_id, payload)
