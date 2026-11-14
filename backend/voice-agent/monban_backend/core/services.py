"""Upstream service checks and LiveKit agent dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp
from livekit import api

from ..config import settings

logger = logging.getLogger("door-services")
AGENT_NAME = settings.livekit_agent_name


async def model_available(
    http: aiohttp.ClientSession, base_url: str, expected_model: str, voice: str | None = None,
    api_key: str = "",
) -> bool:
    try:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        async with http.get(f"{base_url.rstrip('/')}/v1/models", headers=headers) as response:
            if response.status != 200:
                return False
            data = await response.json()
        match = next(
            (model for model in data.get("data", []) if model.get("id") == expected_model), None
        )
        if match is None:
            return False
        if voice:
            voices = match.get("speech", {}).get("voices", [])
            return any(item.get("name") == voice for item in voices)
        return True
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, TypeError):
        return False


async def llm_available(http: aiohttp.ClientSession) -> bool:
    try:
        async with http.get(
            f"{settings.ollama_base_url}/v1/models",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
        ) as response:
            if response.status != 200:
                return False
            data = await response.json()
        return any(
            item.get("id") == settings.llm_model
            for item in data.get("data", [])
        )
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, TypeError):
        return False


async def livekit_available() -> bool:
    try:
        async with api.LiveKitAPI(
            url=settings.livekit_url,
            api_key=settings.livekit_api_key,
            api_secret=settings.livekit_api_secret,
        ) as client:
            await client.room.list_rooms(api.ListRoomsRequest())
        return True
    except Exception as exc:
        logger.info("livekit health check failed: %s", type(exc).__name__)
        return False


async def dispatch_agent(
    room: str,
    house_rules: str,
    reception: dict[str, Any] | None = None,
) -> None:
    """Start the LiveKit agent. ``reception`` (device key and shop) selects shop reception."""
    metadata: dict[str, Any] = {"house_rules": house_rules}
    if reception is not None:
        metadata["reception"] = reception
    async with api.LiveKitAPI(
        url=settings.livekit_url,
        api_key=settings.livekit_api_key,
        api_secret=settings.livekit_api_secret,
    ) as client:
        await client.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=AGENT_NAME,
                room=room,
                metadata=json.dumps(metadata, ensure_ascii=False),
            )
        )
