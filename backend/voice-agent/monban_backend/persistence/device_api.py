"""Client for the Supabase Edge Function ``device`` (settings, shop and reservations).

Accounts, households, shops, reservations and the Google Calendar connection all live in
Supabase. The backend holds no service-role key: it calls the same device endpoint the
paired device uses, authenticated with the device key, so Supabase decides which
household and shop the call belongs to.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import quote

import aiohttp

from ..config import settings
from ..core.house_rules import HouseSettings

logger = logging.getLogger("door-device-api")

MAX_RESPONSE_BYTES = 256 * 1024
WEEKDAYS = ("日", "月", "火", "水", "木", "金", "土")  # business_hours.day follows JS getDay()


class DeviceApiError(Exception):
    """The device API could not be reached or answered with an error."""

    def __init__(self, status: int | None, message: str = "") -> None:
        super().__init__(message or f"device API failed status={status}")
        self.status = status


@dataclass(frozen=True)
class ShopProfile:
    """Shop settings for a household that is a store (``shop_profiles`` in Supabase)."""

    name: str = ""
    business_type: str = ""
    tone: str = ""
    greeting: str = ""
    business_hours: tuple[dict[str, Any], ...] = ()
    walk_in_policy: str = ""
    reservation_provider: str = ""
    services: tuple[dict[str, Any], ...] = ()

    @classmethod
    def from_json(cls, raw: Any) -> ShopProfile | None:
        if not isinstance(raw, dict):
            return None

        def text(key: str) -> str:
            value = raw.get(key)
            return value.strip() if isinstance(value, str) else ""

        def rows(key: str) -> tuple[dict[str, Any], ...]:
            value = raw.get(key)
            return tuple(item for item in value if isinstance(item, dict)) if isinstance(value, list) else ()

        return cls(
            name=text("name"),
            business_type=text("business_type"),
            tone=text("tone"),
            greeting=text("greeting"),
            business_hours=rows("business_hours"),
            walk_in_policy=text("walk_in_policy"),
            reservation_provider=text("reservation_provider"),
            services=rows("services"),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "business_type": self.business_type,
            "tone": self.tone,
            "greeting": self.greeting,
            "business_hours": list(self.business_hours),
            "walk_in_policy": self.walk_in_policy,
            "reservation_provider": self.reservation_provider,
            "services": list(self.services),
        }

    def public_context(self, today: datetime) -> dict[str, str]:
        """Map the shop to the reception prompt's public fields (see store_context)."""
        context: dict[str, str] = {}
        if self.name:
            context["shop_name"] = self.name[:500]
        weekday = (today.weekday() + 1) % 7  # Python Monday=0 -> JS Sunday=0
        closed_days = []
        for item in self.business_hours:
            day = item.get("day")
            if not isinstance(day, int) or not 0 <= day <= 6:
                continue
            if item.get("closed") is True:
                closed_days.append(day)
            elif day == weekday:
                opening, closing = item.get("open"), item.get("close")
                if isinstance(opening, str) and opening:
                    context["opening_time"] = opening[:500]
                if isinstance(closing, str) and closing:
                    context["closing_time"] = closing[:500]
        if closed_days:
            context["closed_day"] = "・".join(f"{WEEKDAYS[day]}曜日" for day in sorted(set(closed_days)))
        return context


@dataclass(frozen=True)
class DeviceSettings:
    house: HouseSettings
    shop: ShopProfile | None = None
    paired: bool = True
    mode: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RemoteReservation:
    id: str
    customer_name: str
    service_name: str | None
    starts_at: datetime
    ends_at: datetime
    status: str
    arrived_at: str | None


def configured() -> bool:
    return bool(settings.supabase_url and settings.supabase_anon_key)


def _headers(device_key: str) -> dict[str, str]:
    return {"apikey": settings.supabase_anon_key, "Authorization": f"Bearer {device_key}"}


async def _request(
    method: str, path: str, device_key: str, *, timeout: float, params: dict[str, str] | None = None
) -> Any:
    if not configured():
        raise DeviceApiError(None, "Supabase URL or public API key is not set")
    url = f"{settings.supabase_url}/functions/v1/device{path}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as http:
            async with http.request(method, url, params=params, headers=_headers(device_key)) as response:
                body = bytearray()
                async for chunk in response.content.iter_chunked(8192):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise DeviceApiError(response.status, "response is too large")
                if response.status >= 400:
                    raise DeviceApiError(response.status)
        return json.loads(body)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
        raise DeviceApiError(None, type(exc).__name__) from exc


async def fetch_device_settings(device_key: str) -> DeviceSettings | None:
    """Read the device's house settings and shop once. Any failure means no settings."""
    if not configured():
        logger.warning("Supabase URL or public API key is not set; using rules without house settings")
        return None
    try:
        data = await _request("GET", "/settings", device_key, timeout=settings.house_settings_timeout_seconds)
    except DeviceApiError as exc:
        logger.warning("house settings request failed: status=%s error=%s", exc.status, exc)
        return None
    away = data.get("away_leave_at_door") if isinstance(data, dict) else None
    extra = data.get("extra_instructions") if isinstance(data, dict) else None
    if not isinstance(away, bool) or not isinstance(extra, str):
        logger.warning("house settings response has an unexpected shape")
        return None
    return DeviceSettings(
        house=HouseSettings(away_leave_at_door=away, extra_instructions=extra),
        shop=ShopProfile.from_json(data.get("shop")),
        paired=data.get("paired") is not False,
        mode=data.get("mode") if isinstance(data.get("mode"), str) else None,
    )


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def parse_reservation(raw: Any) -> RemoteReservation | None:
    if not isinstance(raw, dict):
        return None
    starts_at, ends_at = _parse_time(raw.get("starts_at")), _parse_time(raw.get("ends_at"))
    reservation_id, name = raw.get("id"), raw.get("customer_name")
    if not (isinstance(reservation_id, str) and reservation_id and isinstance(name, str) and starts_at and ends_at):
        return None
    service = raw.get("service_name")
    arrived = raw.get("arrived_at")
    return RemoteReservation(
        id=reservation_id,
        customer_name=name,
        service_name=service if isinstance(service, str) else None,
        starts_at=starts_at,
        ends_at=ends_at,
        status=raw.get("status") if isinstance(raw.get("status"), str) else "",
        arrived_at=arrived if isinstance(arrived, str) else None,
    )


async def list_reservations(device_key: str, start: datetime, end: datetime) -> list[RemoteReservation]:
    """Reservations overlapping [start, end); cancelled ones are excluded by Supabase."""
    data = await _request(
        "GET",
        "/reservations",
        device_key,
        timeout=settings.reservation_timeout_seconds,
        params={"from": start.isoformat(), "to": end.isoformat()},
    )
    items = data.get("reservations") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise DeviceApiError(200, "unexpected reservations response")
    return [item for raw in items if (item := parse_reservation(raw)) is not None]


async def arrive(device_key: str, reservation_id: str) -> RemoteReservation:
    """Record the arrival in Supabase; it notifies the shop's members. Idempotent."""
    data = await _request(
        "POST",
        f"/reservations/{quote(reservation_id, safe='')}/arrive",
        device_key,
        timeout=settings.reservation_timeout_seconds,
    )
    reservation = parse_reservation(data.get("reservation") if isinstance(data, dict) else None)
    if reservation is None:
        raise DeviceApiError(200, "unexpected arrive response")
    return reservation
