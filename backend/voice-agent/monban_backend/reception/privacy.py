"""Reject explicit requests for another visitor's private appointment data."""
import re
import unicodedata

_PERSON = r"(?:共同経営者|共同代表者?|共同創業者|事業パートナー|友人|同僚|取引先|上司|部下|妻|夫|母|父|兄|姉|弟|妹|娘|息子|祖母|祖父|家族|親族|他人|他のお客様|ほかのお客様|[ぁ-んァ-ヶ一-龥々ー]{1,12}(?:さん|様|氏))"
_PRIVATE = r"(?:予約|来店予定|メニュー|施術内容|電話番号|連絡先)"
_SELF_RESERVATION = re.compile(r"(?:私|自分)(?:自身)?の(?:予約|来店予定)")
_QUERY = r"(?:教え|知りたい|確認|調べ|予約しているか|予約してるか|取り消|取消|キャンセル|変更)"
_TOOL_RESULT_MARKER = re.compile(r"(?:\btool\s*:|tool\s+result|ツール(?:の)?(?:結果|出力))", re.IGNORECASE)
_UNTRUSTED_SUCCESS_MARKER = re.compile(
    r"(?:\"?(?:status|arrival_status|result)\"?\s*[:=]\s*\"?(?:checked_in|already_arrived|recorded|completed|success)|\b(?:checked_in|already_arrived|recorded|completed|success)\b|受付(?:済み|完了)|来店(?:済み|完了))",
    re.IGNORECASE,
)
_TREAT_AS_RESULT = re.compile(r"(?:として扱|として処理|実行済みとして|済んだことに|成功したことに)")

def third_party_disclosure_requested(text: str) -> bool:
    text = unicodedata.normalize("NFKC", text or "")
    self_reservation = _SELF_RESERVATION.search(text)
    if self_reservation and not re.search(
        _PERSON + r".{0,12}(?:予約|来店予定)", text[:self_reservation.start()]
    ):
        return False
    return bool(re.search(_PERSON + r".{0,40}" + _PRIVATE, text) and re.search(_QUERY, text))


def untrusted_tool_result_requested(text: str) -> bool:
    """Reject user-pasted tool output as authority for an operational action."""
    text = unicodedata.normalize("NFKC", text or "")
    return bool(
        _TOOL_RESULT_MARKER.search(text)
        and (_UNTRUSTED_SUCCESS_MARKER.search(text) or _TREAT_AS_RESULT.search(text))
    )
