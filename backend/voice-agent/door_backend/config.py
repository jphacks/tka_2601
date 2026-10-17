from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

from dotenv import load_dotenv

load_dotenv()


def _integer(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return parsed


def _positive_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if parsed <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return parsed


def _flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _required_secret(
    name: str, *, development_default: str | None = None, minimum_bytes: int = 32
) -> str:
    value = os.getenv(name, development_default)
    if not value:
        raise ValueError(f"{name} must be set")
    if len(value.encode("utf-8")) < minimum_bytes:
        raise ValueError(f"{name} must contain at least {minimum_bytes} bytes")
    return value


_environment = os.getenv("DOOR_ENV", "development").strip().lower()
if _environment not in {"development", "production"}:
    raise ValueError("DOOR_ENV must be 'development' or 'production'")


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str = _environment
    api_key: str = _required_secret("DOOR_API_KEY")
    livekit_url: str = os.getenv("LIVEKIT_URL", "http://127.0.0.1:7880").rstrip("/")
    livekit_ws_url: str = os.getenv("LIVEKIT_WS_URL", "ws://127.0.0.1:7880").rstrip("/")
    livekit_api_key: str = os.getenv("LIVEKIT_API_KEY", "devkey" if _environment == "development" else "")
    livekit_api_secret: str = _required_secret(
        "LIVEKIT_API_SECRET",
        development_default="secret" if _environment == "development" else None,
        minimum_bytes=32 if _environment == "production" else 1,
    )
    trusted_livekit_http_hosts: tuple[str, ...] = tuple(
        host.strip().lower()
        for host in os.getenv("DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS", "").split(",")
        if host.strip()
    )
    livekit_agent_name: str = os.getenv("LIVEKIT_AGENT_NAME", "door-voice-agent")
    ui_hostname: str = os.getenv("DOOR_UI_HOSTNAME", "door-ui.shionkk.f5.si").lower()
    allowed_hosts: tuple[str, ...] = tuple(
        host.strip().lower()
        for host in os.getenv(
            "DOOR_ALLOWED_HOSTS",
            f"localhost,127.0.0.1,testserver,{os.getenv('DOOR_UI_HOSTNAME', 'door-ui.shionkk.f5.si')}",
        ).split(",")
        if host.strip()
    )

    ollama_base_url: str = os.getenv("DOOR_OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/").removesuffix("/v1")
    llm_model: str = os.getenv("DOOR_LLM_MODEL", "gemma4:latest")
    llm_timeout_seconds: float = _positive_float("DOOR_LLM_TIMEOUT_SECONDS", 30)
    llm_max_tokens: int = _integer("DOOR_LLM_MAX_TOKENS", 96)
    llm_keep_alive: str = os.getenv("DOOR_LLM_KEEP_ALIVE", "30m")
    warmup_enabled: bool = _flag("DOOR_WARMUP", True)
    warmup_timeout_seconds: float = _positive_float("DOOR_WARMUP_TIMEOUT_SECONDS", 90)
    asr_base_url: str = os.getenv("DOOR_ASR_BASE_URL", "http://127.0.0.1:18095").rstrip("/")
    asr_model: str = os.getenv("DOOR_ASR_API_MODEL", "kotoba-tech/kotoba-whisper-v2.1")
    tts_base_url: str = os.getenv("DOOR_TTS_BASE_URL", "http://127.0.0.1:18094").rstrip("/")
    tts_model: str = os.getenv("DOOR_TTS_API_MODEL", "Irodori-TTS-v4.1-Small-MF")
    tts_voice: str = os.getenv("DOOR_TTS_VOICE", "door_neutral")
    tts_sample_rate: int = _integer("DOOR_TTS_SAMPLE_RATE", 48000)
    tts_seed: int = _integer("DOOR_TTS_SEED", 11)
    tts_instructions: str = os.getenv(
        "DOOR_TTS_INSTRUCTIONS",
        "落ち着いた穏やかな口調で、感情を強調せず、自然で丁寧に読み上げてください。",
    )
    house_rules: str = os.getenv(
        "DOOR_HOUSE_RULES",
        "宅配ボックスを優先し、入らない場合は玄関前に置いてください。荷物と置き場所の写真を撮ってください。",
    )
    max_house_rules_chars: int = _integer("DOOR_MAX_HOUSE_RULES_CHARS", 800)
    max_tts_response_bytes: int = _integer("DOOR_MAX_TTS_RESPONSE_BYTES", 5 * 1024 * 1024)
    api_requests_per_minute: int = _integer("DOOR_API_REQUESTS_PER_MINUTE", 120)
    max_concurrent_expensive_requests: int = _integer("DOOR_MAX_CONCURRENT_REQUESTS", 4)
    max_queued_requests: int = _integer("DOOR_MAX_QUEUED_REQUESTS", 8)
    queue_wait_seconds: float = _positive_float("DOOR_QUEUE_WAIT_SECONDS", 2.0)
    max_api_request_bytes: int = _integer("DOOR_MAX_API_REQUEST_BYTES", 16384)
    turn_detector: str = os.getenv("DOOR_TURN_DETECTOR", "vad").lower()
    log_level: str = os.getenv("LOG_LEVEL", "INFO").upper()

    # PSoC 6 relay (/api/relay)
    relay_livekit_url: str = os.getenv(
        "DOOR_RELAY_LIVEKIT_URL",
        os.getenv("LIVEKIT_URL", "http://127.0.0.1:7880").replace("http", "ws", 1),
    ).rstrip("/")
    max_relay_sessions: int = _integer("DOOR_MAX_RELAY_SESSIONS", 4)
    relay_start_timeout_seconds: float = _positive_float("DOOR_RELAY_START_TIMEOUT_SECONDS", 5.0)
    relay_max_session_seconds: float = _positive_float("DOOR_RELAY_MAX_SESSION_SECONDS", 120.0)
    supabase_url: str = os.getenv("DOOR_SUPABASE_URL", "").rstrip("/")
    house_settings_timeout_seconds: float = _positive_float("DOOR_HOUSE_SETTINGS_TIMEOUT_SECONDS", 1.5)


settings = Settings()

if not settings.livekit_api_key:
    raise ValueError("LIVEKIT_API_KEY must be set")

if settings.environment == "production":
    if "*" in settings.allowed_hosts:
        raise ValueError("Production DOOR_ALLOWED_HOSTS must not contain '*'")
    if settings.ui_hostname not in settings.allowed_hosts:
        raise ValueError("Production DOOR_ALLOWED_HOSTS must include DOOR_UI_HOSTNAME")
    if settings.livekit_api_key == "devkey" or settings.livekit_api_secret == "secret":
        raise ValueError("Production requires unique LiveKit credentials; development defaults are forbidden")
    if settings.api_key in {settings.livekit_api_key, settings.livekit_api_secret}:
        raise ValueError("DOOR_API_KEY must be different from LiveKit credentials")
    livekit_api_url = urlsplit(settings.livekit_url)
    local_livekit_http = False
    if livekit_api_url.scheme == "http" and livekit_api_url.hostname:
        try:
            address = ipaddress.ip_address(livekit_api_url.hostname)
            local_livekit_http = address.is_loopback or (
                livekit_api_url.hostname in settings.trusted_livekit_http_hosts
                and address in ipaddress.ip_network("100.64.0.0/10")
            )
        except ValueError:
            local_livekit_http = livekit_api_url.hostname.lower() == "localhost"
    if livekit_api_url.scheme != "https" and not local_livekit_http:
        raise ValueError(
            "Production LIVEKIT_URL must use HTTPS, loopback HTTP, or an explicitly trusted Tailscale IP"
        )
    if urlsplit(settings.livekit_ws_url).scheme != "wss":
        raise ValueError("Production LIVEKIT_WS_URL must use WSS")
    relay_livekit_url = urlsplit(settings.relay_livekit_url)
    if relay_livekit_url.scheme != "wss" and not (
        local_livekit_http and relay_livekit_url.hostname == livekit_api_url.hostname
    ):
        raise ValueError(
            "Production DOOR_RELAY_LIVEKIT_URL must use WSS or the same local host as LIVEKIT_URL"
        )
    if settings.supabase_url and urlsplit(settings.supabase_url).scheme != "https":
        raise ValueError("Production DOOR_SUPABASE_URL must use HTTPS")
