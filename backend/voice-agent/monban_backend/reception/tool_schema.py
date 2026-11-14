"""Canonical reception tool contract shared by runtime and model experiments."""

import re
import unicodedata

from .reason_codes import MODEL_STAFF_REASON_CHOICES
from .business_visits import classify_business_visit


SERVICE_INFO_QUERY = re.compile(
    r"(?:メニュー|施術内容|コース内容|料金|値段|価格|金額|キャンセル料|営業時間|店舗ルール)"
)
HOURS_INFORMATION_QUERY = re.compile(
    r"(?:営業時間|閉店時刻|営業終了時刻|何時まで(?:開いて|営業|受付)|"
    r"何時から(?:開いて|営業)|営業日|定休日)"
)
ARRIVAL_INTENT = re.compile(r"(?:来店|到着|着きました|着いた|入店|チェックイン|受付(?:を|して|お願いします|したい))")
RESERVATION_MENU_QUERY = re.compile(
    r"(?:"
    r"予約(?:を)?(?:お願い(?:した|している|しています|しました|してます)|"
    r"(?:し|して)(?:た|いる|います|ます|る)|"
    r"取(?:った|りました|っている|っています)|"
    r"入れ(?:た|ました|ている|ています)|済み)|"
    r"予約(?:が)?入って(?:いる|います|る|ます)|"
    r"予約の"
    r")"
)
NO_RESERVATION_QUERY = re.compile(
    r"(?:予約(?:(?:は|が|を)?\s*(?:まだ)?\s*(?:ありません|ない|なし|していません|してない|してなくて|しておらず|せず))|予約なし)"
)
MENU_INFORMATION_QUERY = re.compile(r"(?:メニュー|施術内容|コース(?:内容)?|施術プラン|プラン)")
UNSUPPORTED_RESERVATION_ACTION = re.compile(
    r"(?:予約.{0,16}(?:変更|キャンセル|取消|取り消し|新規|追加)|"
    r"(?:変更|キャンセル|取消|取り消し).{0,16}予約|予約を?(?:変更|キャンセル|取消|取り消し)|解錠|開錠)"
)
APPOINTMENT_TIME = re.compile(
    r"(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:半|[0-5]?\d分?)?)"
)
DIRECT_HANDOFF_REQUEST = re.compile(r"(?:スタッフ|担当者|担当の方).{0,12}(?:確認|相談|聞|伝え|依頼|取り次ぎ)")
EARLY_ARRIVAL_WAIT_QUERY = re.compile(
    r"(?:"
    r"(?:早く|早めに|予約.{0,8}より.{0,8}早く).{0,12}(?:着|到着)|"
    r"早着|どこで待|どこに待|どちらで待|待てば|待機すれば|店内で待|待機場所|待ち場所"
    r")"
)
THIRD_PARTY_BOOKING_QUERY = re.compile(
    r"(?:他の方|別の方|ほかのお客様|他のお客様|他人|同僚|友人|家族).{0,10}(?:予約|来店予定)"
    r"|[\u3040-\u30ff\u3400-\u9fffー]{1,12}(?:さん|様|氏)の(?:ご?予約|予約内容|予約時刻|予約時間|予約が|予約は)"
    r"|(?:付き添い|同伴|同行).{0,20}(?:予約|メニュー)|本人の(?:ご?予約|予約内容|予約時刻|メニュー)"
)
STAFF_HANDOFF_QUERY = re.compile(
    r"(?:"
    r"予約.{0,8}(?:変更|キャンセル|取消|取り消し|新規|追加)|"
    r"変更|追加|キャンセル|取消|取り消し|解錠|開錠|鍵を|遅刻|遅れ|延長|"
    r"預かり|預かっ|預かる|預け|保管|受け取り|受取|"
    r"リュック|鞄|かばん|カバン|バッグ|置き場所|置く場所|置ける場所|どこに置|置いても|置かせて|"
    r"待機場所|待ち場所|待っている|待てば|待機すれば|どこで待|どこに待|どちらで待|店内で待|早着|予約なし|予約はありません|飛び込み|"
    r"着替え|上着|持ち物|荷物|伝言|段差|車いす|画像|受け入れ|マット|コンタクト|必要|"
    r"症状|痛み|しびれ|アレルギー|妊娠|体調|"
    r"(?:担当者|スタッフ|人に).{0,12}(?:確認|相談|伝え|聞い)|"
    r"確認して(?:ください|もらえますか|ほしい)|確認をお願いします|相談したい|伝言を"
    r")"
)


def customer_name_is_self_identified(user_text_history: str, customer_name: str) -> bool:
    """Require the queried reservation name to be presented as the visitor's own name."""
    text = unicodedata.normalize("NFKC", user_text_history or "")
    text = re.sub(r"[\s、。,.！!？?「」『』（）()・：:]+", "", text)
    name = unicodedata.normalize("NFKC", customer_name or "")
    name = re.sub(r"[\s、。,.！!？?「」『』（）()・：:]+", "", name)
    name = re.sub(r"(?:さん|様|氏)$", "", name)
    if not name or name not in text:
        return False
    escaped = re.escape(name)
    suffix = r"(?:さん|様)?(?:です|でございます|と申します|といいます|本人です)"
    patterns = (
        rf"(?:私|わたし|僕|ぼく|本人)?(?:は|が)?{escaped}{suffix}",
        rf"(?:私|わたし|僕|ぼく|本人)?(?:は|が)?{escaped}[\u3040-\u30ff\u3400-\u9fffー]{{1,4}}{suffix}",
        rf"(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:半|[0-5]?\d分?)?)(?:の予約で|の)?{escaped}{suffix}",
        rf"(?:予約(?:した|をした|している|しています)|来店した)(?:のは|者は)?{escaped}{suffix}",
        rf"(?:名前|お名前|氏名|予約者)(?:は|が)?{escaped}{suffix}",
        rf"(?:予約名|予約者|予約をした名前)(?:は|が){escaped}(?:さん|様)?(?:です|でした|でお願いします)?",
        rf"{escaped}(?:さん|様)?(?:の名前で|名義で)予約(?:しています|しました|をしています|をしました)",
    )
    return any(re.search(pattern, text) for pattern in patterns)


def search_is_applicable(user_message_history: str) -> bool:
    if classify_business_visit(user_message_history):
        return False
    early_arrival_wait = bool(EARLY_ARRIVAL_WAIT_QUERY.search(user_message_history))
    service_info_only = bool(SERVICE_INFO_QUERY.search(user_message_history)) and not bool(
        ARRIVAL_INTENT.search(user_message_history)
    )
    return (
        not service_info_only
        and not early_arrival_wait
        and not bool(THIRD_PARTY_BOOKING_QUERY.search(user_message_history))
        and not (
            bool(UNSUPPORTED_RESERVATION_ACTION.search(user_message_history))
            and not bool(ARRIVAL_INTENT.search(user_message_history))
        )
    )


def is_reservation_menu_query(user_message: str, conversation_history: str = "") -> bool:
    """Identify menu information about a visitor's own existing reservation."""
    text = unicodedata.normalize("NFKC", user_message or "")
    context = unicodedata.normalize("NFKC", conversation_history or text)
    return (
        bool(MENU_INFORMATION_QUERY.search(text))
        and bool(RESERVATION_MENU_QUERY.search(context))
        and not bool(NO_RESERVATION_QUERY.search(context))
        and not bool(THIRD_PARTY_BOOKING_QUERY.search(text))
    )


def menu_query_needs_time(user_message: str, conversation_history: str = "") -> bool:
    """A reservation-menu question needs appointment time before the agent continues."""
    text = unicodedata.normalize("NFKC", user_message or "")
    context = unicodedata.normalize("NFKC", conversation_history or text)
    return (
        is_reservation_menu_query(text, context)
        and not bool(APPOINTMENT_TIME.search(context))
        and not bool(DIRECT_HANDOFF_REQUEST.search(text))
        and not bool(STAFF_HANDOFF_QUERY.search(text))
    )


def staff_handoff_required(user_message: str, conversation_history: str = "") -> bool:
    """Expose staff handoff only for a current request that needs human judgment."""
    if classify_business_visit(user_message):
        return True
    if menu_query_needs_time(user_message, conversation_history):
        return False
    if HOURS_INFORMATION_QUERY.search(user_message) and not DIRECT_HANDOFF_REQUEST.search(user_message):
        return False
    return bool(SERVICE_INFO_QUERY.search(user_message) or STAFF_HANDOFF_QUERY.search(user_message))


def normalize_staff_reason(reason: str) -> str:
    """Build a stable idempotency key for a staff request within one session."""
    normalized = unicodedata.normalize("NFKC", reason or "").casefold()
    return re.sub(r"[\s、。,.！!？?]+", "", normalized)


def available_tools(
    tools,
    *,
    search_attempted: bool = False,
    arrival_attempted: bool = False,
    request_staff_attempted: bool = False,
    confirmed_reservation: bool = False,
    arrival_recorded: bool = False,
    latest_user_message: str = "",
    request_staff_available: bool = False,
):
    """Expose only tools valid for the current reception state."""
    search_applicable = search_is_applicable(latest_user_message)
    result = []
    for tool in tools:
        if isinstance(tool, dict):
            name = (tool.get("function") or {}).get("name", "")
        else:
            name = getattr(getattr(tool, "_info", None), "name", "")
        if name == "search_reservations" and (
            search_attempted or confirmed_reservation or arrival_recorded or not search_applicable
        ):
            continue
        if name == "complete_arrival" and (
            not confirmed_reservation or arrival_recorded or arrival_attempted
        ):
            continue
        if name == "request_staff" and (
            request_staff_attempted or not request_staff_available
        ):
            continue
        result.append(tool)
    return result

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_reservations",
            "description": "指定された氏名と時刻の予約候補を検索する。読み取り専用。",
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
            "name": "complete_arrival",
            "description": "一意に照合された予約を最新状態で再確認し、来店受付とスタッフ向け一覧への記録を順に行う。各状態を別々に返す。外部通知は送信しない。",
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
            "name": "request_staff",
            "description": "確認や例外対応をスタッフへ依頼する。reasonは、列挙された内容に最も近い短いカテゴリを一つ選ぶ。自由文や原因の推測は入れない。",
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

TOOL_SCHEMAS = {tool["function"]["name"]: tool["function"] for tool in TOOLS}
