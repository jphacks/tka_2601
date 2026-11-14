"""HTTP middleware that bounds request bodies and expensive API work."""

from __future__ import annotations

import asyncio

from fastapi.responses import Response


class RequestBodyLimitMiddleware:
    """Bound API request bodies, including requests without Content-Length."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length:
            try:
                too_large = int(content_length) > self.max_bytes
            except ValueError:
                too_large = False
            if too_large:
                await Response("Request body is too large", status_code=413)(scope, receive, send)
                return

        buffered = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                buffered.append(message)
                break
            if message["type"] == "http.request":
                size += len(message.get("body", b""))
                if size > self.max_bytes:
                    await Response("Request body is too large", status_code=413)(
                        scope, receive, send
                    )
                    return
                buffered.append(message)
                if not message.get("more_body", False):
                    break

        index = 0

        async def replay_receive():
            nonlocal index
            if index < len(buffered):
                message = buffered[index]
                index += 1
                return message
            return await receive()

        await self.app(scope, replay_receive, send)


class CapacityLimiter:
    """Bound active work and the number/time of requests waiting for capacity."""

    def __init__(self, active_limit: int, queue_limit: int, wait_seconds: float):
        self.active_limit = active_limit
        self.queue_limit = queue_limit
        self.wait_seconds = wait_seconds
        self._active = 0
        self._waiting = 0
        self._condition = asyncio.Condition()

    async def acquire(self) -> bool:
        async with self._condition:
            if self._active < self.active_limit:
                self._active += 1
                return True
            if self._waiting >= self.queue_limit:
                return False
            self._waiting += 1
            try:
                await asyncio.wait_for(
                    self._condition.wait_for(lambda: self._active < self.active_limit),
                    timeout=self.wait_seconds,
                )
            except asyncio.TimeoutError:
                self._waiting -= 1
                return False
            except asyncio.CancelledError:
                self._waiting -= 1
                raise
            self._waiting -= 1
            self._active += 1
            return True

    async def release(self) -> None:
        async with self._condition:
            self._active -= 1
            self._condition.notify(1)
