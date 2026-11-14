"""Validated per-store public information and runtime prompt composition."""

from __future__ import annotations

import json
import re
import unicodedata

from .business_visits import BUSINESS_VISIT_POLICY_CHOICES

BUSINESS_VISIT_POLICY_KEYS = {"sales_policy", "fee_collection_policy"}
BUSINESS_VISIT_POLICY_VALUES = BUSINESS_VISIT_POLICY_CHOICES

PUBLIC_CONTEXT_KEYS = {
    "shop_name",
    "opening_time",
    "closing_time",
    "closed_day",
    "payment_methods",
    "address",
    "delivery_location",
}
STORE_CONTEXT_KEYS = PUBLIC_CONTEXT_KEYS | BUSINESS_VISIT_POLICY_KEYS

_OPENING_TIME_QUESTION = re.compile(
    r"(?:何時から.{0,8}(?:営業|開店)|"
    r"(?:営業時間).{0,12}(?:何時から|開店)|"
    r"(?:開店(?:時刻|時間)|営業開始(?:時刻|時間)?).{0,12}(?:何時|いつ|教えて|ですか|でしょうか))"
)
_CLOSING_TIME_QUESTION = re.compile(
    r"(?:閉店(?:時刻|時間)?|何時まで(?:営業|開いて|やっています|ですか)|"
    r"何時に閉ま(?:る|ります(?:か)?)?|営業終了(?:時刻|時間)?)"
)

_PUBLIC_INFO_PATTERNS = {
    "shop_name": re.compile(
        r"(?:店名|店舗名|お店の名前|何という(?:お?店|店)|なんというお店)"
    ),
    "opening_time": _OPENING_TIME_QUESTION,
    "closing_time": re.compile(
        r"(?:営業時間|閉店(?:時刻|時間)?|何時まで(?:営業|開いて|やっています|ですか)|"
        r"何時に閉ま(?:る|ります(?:か)?)?)"
    ),
    "closed_day": re.compile(
        r"(?:定休日|お休みの曜日|お休み(?:は|の日|いつ|ですか)|何曜日(?:が)?休み)"
    ),
    "payment_methods": re.compile(
        r"(?:支払(?:い|方法)|決済方法|使える決済|クレジットカード|カード使え|PayPay)"
    ),
    "address": re.compile(
        r"(?:住所|所在地|アクセス|どこに(?:あります|ある)|場所(?:を|は).{0,8}(?:教|知))"
    ),
    "delivery_location": re.compile(
        r"(?:荷物.{0,8}(?:どこ|置き場所|受取場所|受け渡し場所)|"
        r"(?:宅配|配達).{0,8}(?:受取場所|受け渡し場所|置き場所)|"
        r"受け取り場所|受取場所|受け渡し場所)"
    ),
}
_STAFF_REQUEST = re.compile(
    r"(?:スタッフ|担当者|店員|従業員).{0,12}(?:確認|聞|呼|伝|問い合わせ|相談)"
    r"|(?:確認|聞|呼|伝|問い合わせ).{0,12}(?:スタッフ|担当者|店員|従業員)"
)
_OPEN_STATUS_QUESTION = re.compile(
    r"(?:こちら|この店|お店|店舗|本日|今日)?(?:は|も)?営業して"
    r"(?:いますか|ますか|おりますか|いるんですか|るんですか|ますでしょうか)"
)
_INDEPENDENT_INTENT = re.compile(
    r"(?:予約|来店受付|チェックイン|キャンセル|変更|遅刻|遅れ|早く着|早めに来|"
    r"待機場所|待ち場所|施術|指名|予約を取り|予約の確認|受付して)"
)


def normalize_public_context(values: dict) -> dict[str, str]:
    if not isinstance(values, dict) or set(values) - PUBLIC_CONTEXT_KEYS:
        raise ValueError("public store context contains unsupported fields")
    normalized: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(value, str):
            raise ValueError("public setting values must be strings")
        value = value.strip()
        if len(value) > 500:
            raise ValueError("public setting values must be at most 500 characters")
        if value:
            normalized[key] = value
    return normalized


def _policy_instruction(value: str) -> str:
    if value == "staff_handoff":
        return (
            "スタッフへ一度だけ確認依頼する。request_staff(reason「その他スタッフ確認」)を使用し、"
            "予約検索・来店受付・受付一覧への来店記録はしない。依頼が記録された後も担当者の返答済みとは言わない。"
        )
    return "ツールを呼ばず、短く丁寧にお断りする。"


def compose_system_prompt(policy: str, store_context: dict | None = None) -> str:
    if store_context is None:
        return policy
    if not isinstance(store_context, dict) or set(store_context) - STORE_CONTEXT_KEYS:
        raise ValueError(
            "store_context must contain only supported public settings and business-visit policies"
        )

    public_context = {
        key: value for key, value in store_context.items() if key in PUBLIC_CONTEXT_KEYS
    }
    for value in public_context.values():
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ValueError("public setting values must be nonempty bounded strings")

    policies = {
        key: store_context.get(key, "staff_handoff")
        for key in BUSINESS_VISIT_POLICY_KEYS
    }
    for value in policies.values():
        if not isinstance(value, str) or value not in BUSINESS_VISIT_POLICY_VALUES:
            raise ValueError(
                "business-visit policies must be staff_handoff or polite_decline"
            )

    parts = [policy]
    if public_context or not store_context:
        parts.append(
            "店舗の公開設定（未設定の項目は不明）:\n"
            + json.dumps(public_context, ensure_ascii=False, sort_keys=True)
        )
    if public_context:
        parts.append(
            "設定された公開情報に質問の答えがある場合、予約照合やスタッフ確認の流れよりも、その公開情報への回答を優先します。"
            "予約確認の途中でも来訪者が別の質問をしたら、その質問に設定値で直接答えてから元の用件へ戻ります。"
            "設定値で回答できる質問にはrequest_staffなどのツールを使いません。"
            "質問と設定項目の対応は、shop_nameは店舗名、opening_timeは開店時刻・何時から営業するか、"
            "closing_timeは閉店時刻、closed_dayは定休日、"
            "payment_methodsは支払方法、addressは住所、delivery_locationは荷物の受渡し場所や置き場所です。"
            "この対応に一致した設定値をそのまま回答し、予約者名や予約時刻を催促しません。"
            "delivery_locationが設定されている場合、荷物の受渡し場所や置き場所はその値を案内し、荷物置き場の確認依頼を出しません。"
        )
    if BUSINESS_VISIT_POLICY_KEYS & store_context.keys():
        sales = _policy_instruction(policies["sales_policy"])
        collection = _policy_instruction(policies["fee_collection_policy"])
        parts.append(
            "店舗別の営業・集金訪問設定（必ず従う）:\n"
            f"営業訪問: {sales}\n"
            f"NHK・受信料などの集金訪問: {collection}支払いの要否や契約状態を推測しない。\n"
            "どちらも予約客として扱わず、予約者名や予約時刻を尋ねない。"
            "会話中に氏名だけが伝えられても訪問目的を保持する。"
            "明確な目的訂正があった場合は、訂正後の用件に従う。"
        )
    return "\n\n".join(parts)


def public_info_reply(text: str, public_context: dict[str, str]) -> str | None:
    """Answer a single, explicit public-info question from configured store data."""
    normalized = unicodedata.normalize("NFKC", text or "")
    if not normalized or _STAFF_REQUEST.search(normalized) or _INDEPENDENT_INTENT.search(normalized):
        return None
    opening_question = _OPENING_TIME_QUESTION.search(normalized)
    closing_question = _CLOSING_TIME_QUESTION.search(normalized)
    if opening_question and closing_question:
        return None
    explicit_time_question = None
    if opening_question:
        explicit_time_question = "opening_time"
    elif closing_question:
        explicit_time_question = "closing_time"
    if explicit_time_question:
        other_matches = [
            key for key, pattern in _PUBLIC_INFO_PATTERNS.items()
            if key not in {"opening_time", "closing_time"} and pattern.search(normalized)
        ]
        if other_matches:
            return None
        value = public_context.get(explicit_time_question, "")
        if not value:
            return "その情報はこの店舗に設定されていないため、こちらでは確認できません。"
        label = "開店時刻" if explicit_time_question == "opening_time" else "閉店時刻"
        return f"{label}は{value}です。"
    if _OPEN_STATUS_QUESTION.search(normalized):
        return "現在営業中かどうかは、こちらでは確認できません。"
    matches = [key for key, pattern in _PUBLIC_INFO_PATTERNS.items() if pattern.search(normalized)]
    if len(matches) != 1:
        return None

    key = matches[0]
    value = public_context.get(key, "")
    if not value:
        return "その情報はこの店舗に設定されていないため、こちらでは確認できません。"
    replies = {
        "shop_name": f"こちらは{value}です。",
        "opening_time": f"開店時刻は{value}です。",
        "closing_time": f"閉店時刻は{value}です。",
        "closed_day": f"定休日は{value}です。",
        "payment_methods": f"お支払い方法は{value}です。",
        "address": f"住所は{value}です。",
        "delivery_location": f"お荷物の受け渡し場所は{value}です。",
    }
    return replies[key]
