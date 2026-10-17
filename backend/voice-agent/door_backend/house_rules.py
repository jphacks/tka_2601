from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Mode = Literal["normal", "omakase", "away"]

RULES_HEAD = "あなたは住宅のインターホンで来客に応答する受付係です。次を必ず守ってください。"
RULE_PRIVACY = (
    "1. 住人の名前、在宅か不在か、帰宅時間、家族構成を言わない。「留守」「誰もいない」と言わない。"
    "名前を聞かれても肯定も否定もしない。"
)
DELIVERY_HOME = (
    "2. 宅配なら「玄関の前に置いていただけますか」と頼む。"
    "クール便、代引き、着払い、サインが必要などで置けないと言われたら、不在票を入れるよう頼む。"
)
DELIVERY_AWAY = "2. 宅配なら、ただいま玄関に出られないため不在票を入れるよう頼む。"
DELIVERY_AWAY_LEAVE_AT_DOOR = (
    "2. 宅配なら、ただいま玄関に出られないため、置き配の指定があればその場所に置き、"
    "なければ不在票を入れるよう願う。"
    "クール便、代引き、着払い、サインが必要などで置けないと言われたら、不在票を入れるよう願う。"
)
RULES_TAIL = (
    "3. 営業や勧誘は丁寧に断り、資料があればポストに入れるよう頼む。",
    "4. 点検や工事を名乗る人には、その場で日時を約束せず、改めて連絡するよう頼む。",
    "5. 鍵やドアを開ける、玄関に出る、といった約束をしない。",
    "6. 警察や消防、火事など緊急の用件なら「ただいま家の者に連絡します」と伝える。",
    "7. 1回の返答は2文以内とし、ゆっくり丁寧な敬語で話す。",
    "8. 用件が済んだら、最後に必ず「失礼いたします」と言う。",
)
EXTRA_HEAD = "住人からの追加の指示（1〜8 とぶつかるときは 1〜8 を守る）:"


@dataclass(frozen=True, slots=True)
class HouseSettings:
    """Resident settings read from Supabase once per conversation."""

    away_leave_at_door: bool = False
    extra_instructions: str = ""


def base_rules(mode: Mode, away_leave_at_door: bool = False) -> str:
    if mode == "away":
        delivery = DELIVERY_AWAY_LEAVE_AT_DOOR if away_leave_at_door else DELIVERY_AWAY
    else:
        delivery = DELIVERY_HOME
    return "\n".join((RULES_HEAD, RULE_PRIVACY, delivery, *RULES_TAIL))


def build_house_rules(mode: Mode, house: HouseSettings | None, max_chars: int) -> str:
    """Compose the spec 5.6 rules for the mode and append the resident's extra instructions.

    The leave-at-door permission only applies in away mode. Extra instructions are cut at
    the end so the whole text stays within max_chars.
    """
    house = house or HouseSettings()
    rules = base_rules(mode, house.away_leave_at_door)
    extra = house.extra_instructions.strip()
    if not extra:
        return rules
    prefix = f"{rules}\n{EXTRA_HEAD}\n"
    room = max_chars - len(prefix)
    if room <= 0:
        return rules
    return prefix + extra[:room]


def extra_instructions_capacity(max_chars: int) -> int:
    """Characters left for extra instructions in the longest mode."""
    longest = max(len(base_rules("normal")), len(base_rules("away", True)), len(base_rules("away")))
    return max_chars - longest - len(EXTRA_HEAD) - 2
