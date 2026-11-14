"""Classification and per-store policy for non-customer business visits."""

import re
import unicodedata

BUSINESS_VISIT_POLICY_CHOICES = {"staff_handoff", "polite_decline"}
DEFAULT_BUSINESS_VISIT_POLICIES = {
    "sales_policy": "staff_handoff",
    "fee_collection_policy": "staff_handoff",
}
BUSINESS_VISIT_REASON_CODES = {
    "sales": "営業訪問",
    "fee_collection": "集金訪問",
}
PURPOSE_CORRECTION = re.compile(
    r"(?:ではなくて|ではなく|じゃなくて|じゃなく|ではありません|じゃありません|ではない(?:です)?)"
)


def normalize_business_visit_policies(sales_policy=None, fee_collection_policy=None):
    values = {
        "sales_policy": sales_policy or DEFAULT_BUSINESS_VISIT_POLICIES["sales_policy"],
        "fee_collection_policy": fee_collection_policy
        or DEFAULT_BUSINESS_VISIT_POLICIES["fee_collection_policy"],
    }
    if any(value not in BUSINESS_VISIT_POLICY_CHOICES for value in values.values()):
        raise ValueError("営業・集金の応対方針が不正です")
    return values


def classify_business_visit(text: str) -> str | None:
    normalized = unicodedata.normalize("NFKC", text or "")
    corrections = list(PURPOSE_CORRECTION.finditer(normalized))
    if corrections:
        normalized = normalized[corrections[-1].end():]
    folded = normalized.casefold()
    fee_collection = re.search(
        r"(?:nhk|日本放送協会).{0,16}(?:受信料|集金|契約|訪問|伺|来|参|案内|担当|者)"
        r"|(?:受信料|集金|料金徴収|受信契約).{0,16}(?:伺|訪問|来|参|案内|確認|です)",
        folded,
    )
    if fee_collection:
        return "fee_collection"

    hours_question = re.search(
        r"(?:営業時間|営業日|営業中|営業状況|営業状態|何時まで営業|何時から営業|"
        r"(?:こちら|お店|店舗|本日|今日)?営業して(?:いますか|ますか|る|おりますか))",
        normalized,
    )
    clear_sales = re.search(
        r"(?:勧誘|セールス|訪問販売|営業マン|新サービス|営業のご案内|"
        r"営業に(?:伺|参)|営業で(?:伺|参)|営業を行なっているもの|営業を行っているもの|"
        r"営業(?:です|で伺|に伺|に参|で参))",
        normalized,
    )
    if clear_sales:
        return "sales"
    if hours_question:
        return None
    if "営業" in normalized and re.search(
        r"(?:この辺り|こちらに|サロンに|訪問|ご案内|提案|来ました|参りました)",
        normalized,
    ):
        return "sales"
    return None


def business_visit_decline_reply(kind: str) -> str:
    if kind == "fee_collection":
        return "恐れ入りますが、この店舗では集金には対応しておりません。ご了承ください。"
    return "恐れ入りますが、この店舗では営業のご案内をお受けしておりません。ご了承ください。"
