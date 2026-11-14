"""Monban v17 four-tool reception contract shared by runtime and evaluation."""

from .reason_codes import MODEL_STAFF_REASON_CHOICES
from .tool_schema import (
    customer_name_is_self_identified,
    normalize_staff_reason,
    search_is_applicable,
)


TOOLS_V17 = [
    {
        "type": "function",
        "function": {
            "name": "search_reservations",
            "description": "予約候補を読み取り専用で検索する。本人の氏名と時刻を使う。",
            "parameters": {
                "type": "object",
                "properties": {
                    "customer_name": {"type": "string"},
                    "time": {
                        "type": ["string", "null"],
                        "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$",
                    },
                },
                "required": ["customer_name", "time"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_in",
            "description": "一意に照合された予約を最新状態で再確認して来店受付を記録する。",
            "parameters": {
                "type": "object",
                "properties": {"reservation_id": {"type": "string"}},
                "required": ["reservation_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notify_staff",
            "description": "来店受付後、スタッフ向け受付一覧へ記録する。外部通知や既読確認ではない。reasonは「予約客の来店」。",
            "parameters": {
                "type": "object",
                "properties": {
                    "reservation_id": {"type": "string"},
                    "reason": {"type": "string", "enum": ["予約客の来店"]},
                },
                "required": ["reservation_id", "reason"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "request_staff",
            "description": "確認や例外対応をスタッフへ依頼する。reasonは列挙された短いカテゴリから選ぶ。",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "enum": list(MODEL_STAFF_REASON_CHOICES),
                    }
                },
                "required": ["reason"],
                "additionalProperties": False,
            },
        },
    },
]

TOOL_SCHEMAS_V17 = {
    tool["function"]["name"]: tool["function"] for tool in TOOLS_V17
}


def available_tools_v17(
    tools,
    *,
    search_attempted=False,
    check_in_attempted=False,
    notify_staff_attempted=False,
    request_staff_attempted=False,
    confirmed_reservation=False,
    arrival_recorded=False,
    arrival_recorded_this_turn=False,
    latest_user_message="",
    request_staff_available=False,
    business_visit=False,
):
    """Expose tools only when the confirmed reception state permits them."""
    search_applicable = search_is_applicable(latest_user_message)
    has_arrival = arrival_recorded or arrival_recorded_this_turn
    result = []
    for tool in tools:
        if isinstance(tool, dict):
            name = (tool.get("function") or {}).get("name", "")
        else:
            name = getattr(getattr(tool, "_info", None), "name", "")
        if name == "search_reservations" and (
            search_attempted or confirmed_reservation or has_arrival or not search_applicable
        ):
            continue
        if business_visit and name in {"search_reservations", "check_in", "notify_staff"}:
            continue
        if name == "check_in" and (
            not confirmed_reservation or check_in_attempted or has_arrival
        ):
            continue
        if name == "notify_staff" and (
            not arrival_recorded_this_turn or notify_staff_attempted
        ):
            continue
        if name == "request_staff" and (
            request_staff_attempted or not request_staff_available
        ):
            continue
        result.append(tool)
    return result
