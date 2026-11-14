import asyncio

import pytest

from monban_backend.reception.cache import ReservationCache


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_cache_reuses_a_fresh_value_and_refetches_after_ttl():
    clock = Clock()
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        return [calls]

    cache = ReservationCache(fetch, ttl=30, clock=clock)

    async def scenario():
        assert await cache.get("day-1") == [1]
        assert await cache.get("day-1") == [1]
        clock.now = 29.9
        assert await cache.get("day-1") == [1]
        clock.now = 30.0
        assert await cache.get("day-1") == [2]

    asyncio.run(scenario())
    assert calls == 2


def test_cache_does_not_share_between_days_or_calendars():
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        return [calls]

    cache = ReservationCache(fetch, ttl=30, clock=Clock())

    async def scenario():
        assert await cache.get(("2026-11-03", "calendar-a", "1")) == [1]
        assert await cache.get(("2026-11-04", "calendar-a", "1")) == [2]
        assert await cache.get(("2026-11-04", "calendar-b", "1")) == [3]

    asyncio.run(scenario())
    assert calls == 3


def test_concurrent_lookups_share_one_request():
    calls = 0
    release = asyncio.Event()

    async def fetch():
        nonlocal calls
        calls += 1
        await release.wait()
        return ["reservation"]

    cache = ReservationCache(fetch, ttl=30, clock=Clock())

    async def scenario():
        first = asyncio.create_task(cache.get("day"))
        second = asyncio.create_task(cache.get("day"))
        while calls == 0:
            await asyncio.sleep(0)
        assert calls == 1
        release.set()
        assert await first == await second == ["reservation"]

    asyncio.run(scenario())
    assert calls == 1


def test_prefetch_warms_the_cache_without_raising_on_failure():
    clock = Clock()
    calls = 0
    fail = False

    async def fetch():
        nonlocal calls
        calls += 1
        if fail:
            raise RuntimeError("offline")
        return ["reservation"]

    cache = ReservationCache(fetch, ttl=30, clock=clock)

    async def scenario():
        await cache.prefetch("day")
        assert await cache.get("day") == ["reservation"]
        assert calls == 1

        clock.now = 31
        cache.invalidate()
        await cache.prefetch("day")
        assert calls == 2

    asyncio.run(scenario())


def test_failure_discards_stale_data_and_invalidation_forces_a_new_read():
    calls = 0
    fail = False

    async def fetch():
        nonlocal calls
        calls += 1
        if fail:
            raise RuntimeError("offline")
        return [f"value-{calls}"]

    cache = ReservationCache(fetch, ttl=30, clock=Clock())

    async def scenario():
        nonlocal fail
        assert await cache.get("day") == ["value-1"]
        cache.invalidate()
        fail = True
        with pytest.raises(RuntimeError):
            await cache.get("day")
        assert cache.peek("day") is None
        fail = False
        assert await cache.get("day") == ["value-3"]

    asyncio.run(scenario())


def test_invalidation_during_a_fetch_does_not_return_stale_data():
    calls = 0
    release = asyncio.Event()

    async def fetch():
        nonlocal calls
        calls += 1
        value = calls
        if value == 1:
            await release.wait()
        return [f"value-{value}"]

    cache = ReservationCache(fetch, ttl=30, clock=Clock())

    async def scenario():
        pending = asyncio.create_task(cache.get("day"))
        while calls == 0:
            await asyncio.sleep(0)
        cache.invalidate()
        release.set()
        assert await pending == ["value-2"]

    asyncio.run(scenario())
    assert calls == 2


def test_prime_reuses_a_listing_fetched_by_the_settings_screen():
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        return ["fetched"]

    cache = ReservationCache(fetch, ttl=30, clock=Clock())

    async def scenario():
        cache.prime("day", ["listed"])
        assert await cache.get("day") == ["listed"]

    asyncio.run(scenario())
    assert calls == 0
