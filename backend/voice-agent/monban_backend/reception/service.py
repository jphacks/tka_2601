"""Reception use cases for one shop: prefetch, match and record a confirmed arrival.

Reservations live in Supabase (``reservations``; Google Calendar or Square are synced
there by Supabase Edge Functions). The voice agent reads them through the device API with
the device key of the shop's terminal, so one :class:`ReceptionDesk` serves one call.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, time as day_time, timedelta
from zoneinfo import ZoneInfo

from ..config import settings
from ..persistence import device_api
from .cache import ReservationCache
from .matching import Reservation, match_reservations, normalize_name

logger = logging.getLogger("door-reception")
TZ = ZoneInfo("Asia/Tokyo")
DEFAULT_GUIDANCE = "お入りになってお待ちください。"


@dataclass(frozen=True)
class Confirmation:
    status: str  # "arrived" | "already_arrived" | "needs_staff" | "unavailable"
    reservation: Reservation | None = None


@dataclass(frozen=True)
class SearchResult:
    status: str  # "matched" | "not_found" | "ambiguous" | "unavailable" | "invalid_time"
    reservations: tuple[Reservation, ...] = ()


def _today_range(now: datetime | None = None) -> tuple[datetime, datetime]:
    today = (now or datetime.now(TZ)).astimezone(TZ).date()
    start = datetime.combine(today, day_time.min, TZ)
    return start, start + timedelta(days=1)


def _to_reservation(item: device_api.RemoteReservation) -> Reservation:
    return Reservation(
        event_id=item.id,
        start=item.starts_at,
        name=item.customer_name,
        kana="",
        staff=item.service_name or "",
        arrived=item.arrived_at is not None,
    )


class ReceptionDesk:
    """Today's reservations and arrivals for the shop that owns ``device_key``.

    Without a device key (an unpaired terminal) every lookup is ``unavailable`` so the
    agent hands the visitor to staff instead of guessing.
    """

    def __init__(self, device_key: str | None, *, ttl: float | None = None) -> None:
        self._device_key = device_key
        self.cache: ReservationCache[list[Reservation]] = ReservationCache(
            self._fetch, ttl=settings.calendar_cache_seconds if ttl is None else ttl
        )
        self._staff_notified: dict[str, str] = {}
        self.staff_requests: list[str] = []

    @property
    def available(self) -> bool:
        return self._device_key is not None

    async def _fetch(self) -> list[Reservation]:
        if self._device_key is None:
            raise device_api.DeviceApiError(None, "device is not paired")
        start, end = _today_range()
        items = await device_api.list_reservations(self._device_key, start, end)
        return [_to_reservation(item) for item in items if item.status != "cancelled"]

    @staticmethod
    def cache_key() -> str:
        """A key that changes on a new day."""
        return datetime.now(TZ).date().isoformat()

    async def reservations(self) -> list[Reservation]:
        return await self.cache.get(self.cache_key())

    async def prefetch(self) -> None:
        """Warm today's reservations without blocking the greeting or the first turn."""
        await self.cache.prefetch(self.cache_key())

    def invalidate(self) -> None:
        self.cache.invalidate()

    async def search_reservations(self, name: str, requested_time: str | None) -> SearchResult:
        """Read-only lookup used by the agent's search tool."""
        normalized = normalize_name(name)
        if not normalized:
            return SearchResult("not_found")
        try:
            available = await self.reservations()
        except Exception as exc:
            logger.warning("reservation search failed error=%s", type(exc).__name__)
            return SearchResult("unavailable")

        if requested_time is None:
            matches = [
                item for item in available
                if normalized in {normalize_name(item.name), normalize_name(item.kana)}
            ]
        else:
            try:
                parsed = datetime.strptime(requested_time, "%H:%M")
                if parsed.strftime("%H:%M") != requested_time:
                    raise ValueError("not canonical HH:MM")
            except ValueError:
                return SearchResult("invalid_time")
            now = datetime.now(TZ)
            requested = now.replace(hour=parsed.hour, minute=parsed.minute, second=0, microsecond=0)
            matches = match_reservations(available, name, requested)

        if not matches:
            return SearchResult("not_found")
        if len(matches) != 1:
            return SearchResult("ambiguous", tuple(matches))
        return SearchResult("matched", tuple(matches))

    async def record_arrival(self, reservation: Reservation) -> Confirmation:
        """Re-read the reservations before the write so a stale search cannot check in."""
        started = time.monotonic()
        try:
            fresh = await self._fetch()
        except Exception as exc:
            self.request_staff(reservation.name)
            logger.warning("arrival revalidation failed error=%s", type(exc).__name__)
            return Confirmation("unavailable")

        current = [item for item in fresh if item.event_id == reservation.event_id]
        if len(current) != 1:
            self.request_staff(reservation.name)
            return Confirmation("needs_staff")
        candidate = current[0]
        same_customer = normalize_name(candidate.name) in {
            normalize_name(reservation.name), normalize_name(reservation.kana)
        }
        if not same_customer or candidate.start != reservation.start:
            self.request_staff(reservation.name)
            return Confirmation("needs_staff")
        if candidate.arrived:
            return Confirmation("already_arrived", candidate)

        assert self._device_key is not None  # _fetch succeeded
        try:
            await device_api.arrive(self._device_key, candidate.event_id)
        except Exception as exc:
            logger.warning("arrival record failed error=%s", type(exc).__name__)
            return Confirmation("unavailable")
        self.cache.invalidate()
        logger.info("arrival recorded after revalidation duration_ms=%.0f", (time.monotonic() - started) * 1000)
        return Confirmation("arrived", candidate)

    def notify_staff_recorded(self, event_id: str, reason: str) -> dict:
        """Supabase notifies the shop's members when the arrival is recorded."""
        if event_id in self._staff_notified:
            return {"status": "already_recorded", "channel": "staff_reception_list"}
        self._staff_notified[event_id] = reason[:200]
        return {"status": "recorded", "channel": "staff_reception_list"}

    def request_staff(self, reason: str) -> None:
        """Keep the request with this call; it is saved as the visit's outcome."""
        self.staff_requests.append(reason[:200])
        logger.info("staff confirmation requested count=%d", len(self.staff_requests))

    async def confirm(self, name: str, requested: datetime) -> Confirmation:
        """Match a finalized utterance and record exactly one visit.

        A lookup failure is never treated as "no reservation". It records a staff
        confirmation request, as do zero or multiple matches.
        """
        try:
            matches = match_reservations(await self.reservations(), name, requested)
        except Exception as exc:
            self.request_staff(name)
            logger.warning("reservation lookup failed error=%s", type(exc).__name__)
            return Confirmation("unavailable")
        if len(matches) != 1:
            self.request_staff(name)
            return Confirmation("needs_staff")
        return await self.record_arrival(matches[0])

    @staticmethod
    def guidance() -> str:
        return DEFAULT_GUIDANCE
