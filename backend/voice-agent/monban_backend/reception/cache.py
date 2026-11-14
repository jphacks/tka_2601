"""Short-lived cache for the reservations fetched from Google Calendar.

Reception sessions fetch the calendar in the background while the visitor is still
speaking, so a confirmed turn does not wait for Google. A successful fetch is reused for
``ttl`` seconds. Concurrent lookups share one in-flight request, and ``invalidate`` drops
the value and prevents an older request from writing it back.

The cache deliberately keeps failures out of the cache: if a fetch fails, the previous
value is discarded so reception cannot confirm a visit from stale data. Callers must treat
the failure as "staff confirmation required".
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Generic, Hashable, TypeVar

logger = logging.getLogger("door-reception-cache")

T = TypeVar("T")


@dataclass(frozen=True)
class _Entry(Generic[T]):
    key: Hashable
    value: T
    expires: float


class ReservationCache(Generic[T]):
    def __init__(
        self,
        fetch: Callable[[], Awaitable[T]],
        *,
        ttl: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fetch = fetch
        self._ttl = ttl
        self._clock = clock
        self._entry: _Entry[T] | None = None
        self._inflight: asyncio.Task[T] | None = None
        self._inflight_key: Hashable | None = None
        self._inflight_generation = -1
        self._generation = 0

    def _fresh(self, key: Hashable) -> _Entry[T] | None:
        entry = self._entry
        if entry is not None and entry.key == key and self._clock() < entry.expires:
            return entry
        return None

    def peek(self, key: Hashable) -> T | None:
        """Return a fresh value without fetching, or ``None``."""
        entry = self._fresh(key)
        return entry.value if entry is not None else None

    async def get(self, key: Hashable) -> T:
        while True:
            entry = self._fresh(key)
            if entry is not None:
                return entry.value
            generation = self._generation
            value = await asyncio.shield(self._task_for(key))
            if generation == self._generation:
                return value
            # The calendar was switched or disconnected while the fetch was running.
            # Do not hand stale data to the caller; look up again with the new key.

    async def prefetch(self, key: Hashable) -> None:
        """Warm the cache without blocking the caller and without raising."""
        if self._fresh(key) is not None:
            return
        try:
            await asyncio.shield(self._task_for(key))
        except Exception:
            # _load already logged the failure; a later lookup retries.
            pass

    def prime(self, key: Hashable, value: T) -> None:
        """Store a value fetched elsewhere (for example the settings screen)."""
        self._entry = _Entry(key, value, self._clock() + self._ttl)

    def invalidate(self) -> None:
        self._generation += 1
        self._entry = None

    def _task_for(self, key: Hashable) -> asyncio.Task[T]:
        if (
            self._inflight is not None
            and not self._inflight.done()
            and self._inflight_key == key
            and self._inflight_generation == self._generation
        ):
            return self._inflight
        self._inflight_key = key
        self._inflight_generation = self._generation
        self._inflight = asyncio.create_task(self._load(key))
        return self._inflight

    async def _load(self, key: Hashable) -> T:
        generation = self._generation
        started = self._clock()
        try:
            value = await self._fetch()
        except Exception as exc:
            logger.warning(
                "calendar fetch failed duration_ms=%.0f error=%s",
                (self._clock() - started) * 1000,
                type(exc).__name__,
            )
            if generation == self._generation:
                self._entry = None
            raise
        if generation == self._generation:
            self._entry = _Entry(key, value, self._clock() + self._ttl)
        logger.info(
            "calendar fetched count=%s duration_ms=%.0f",
            len(value) if hasattr(value, "__len__") else "?",
            (self._clock() - started) * 1000,
        )
        return value
