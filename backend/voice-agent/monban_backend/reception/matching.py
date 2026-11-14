from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).strip()
    value = re.sub(r"(?:様|さん)$", "", value)
    value = re.sub(r"\s+", "", value)
    return "".join(chr(ord(char) + 0x60) if "ぁ" <= char <= "ゖ" else char for char in value)


@dataclass(frozen=True)
class Reservation:
    event_id: str
    start: datetime
    name: str
    kana: str
    staff: str = ""
    arrived: bool = False


def match_reservations(reservations: list[Reservation], name: str, requested: datetime) -> list[Reservation]:
    normalized = normalize_name(name)
    if not normalized or requested.tzinfo is None:
        return []
    return [item for item in reservations if normalized in {normalize_name(item.name), normalize_name(item.kana)}
            and abs(item.start - requested) <= timedelta(minutes=15)]
