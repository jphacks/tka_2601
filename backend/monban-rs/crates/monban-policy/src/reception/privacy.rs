//! Port of `monban_backend/reception/privacy.py`.

use crate::py_regex;
use crate::pyre::{nfkc, prefix};

macro_rules! person {
    () => {
        r"(?:共同経営者|共同代表者?|共同創業者|事業パートナー|友人|同僚|取引先|上司|部下|妻|夫|母|父|兄|姉|弟|妹|娘|息子|祖母|祖父|家族|親族|他人|他のお客様|ほかのお客様|[ぁ-んァ-ヶ一-龥々ー]{1,12}(?:さん|様|氏))"
    };
}
macro_rules! private {
    () => {
        r"(?:予約|来店予定|メニュー|施術内容|電話番号|連絡先)"
    };
}

py_regex!(SELF_RESERVATION, r"(?:私|自分)(?:自身)?の(?:予約|来店予定)");
py_regex!(
    QUERY,
    r"(?:教え|知りたい|確認|調べ|予約しているか|予約してるか|取り消|取消|キャンセル|変更)"
);
py_regex!(
    TOOL_RESULT_MARKER,
    flags = "i",
    r"(?:\btool\s*:|tool\s+result|ツール(?:の)?(?:結果|出力))"
);
py_regex!(
    UNTRUSTED_SUCCESS_MARKER,
    flags = "i",
    r#"(?:"?(?:status|arrival_status|result)"?\s*[:=]\s*"?(?:checked_in|already_arrived|recorded|completed|success)|\b(?:checked_in|already_arrived|recorded|completed|success)\b|受付(?:済み|完了)|来店(?:済み|完了))"#
);
py_regex!(
    TREAT_AS_RESULT,
    r"(?:として扱|として処理|実行済みとして|済んだことに|成功したことに)"
);
py_regex!(PERSON_RESERVATION, person!(), r".{0,12}(?:予約|来店予定)");
py_regex!(PERSON_PRIVATE, person!(), r".{0,40}", private!());

/// An explicit request for another visitor's private appointment data.
pub fn third_party_disclosure_requested(text: &str) -> bool {
    let text = nfkc(text);
    if let Some(self_reservation) = SELF_RESERVATION.search(&text) {
        if !PERSON_RESERVATION.is_match(&prefix(&text, self_reservation.start)) {
            return false;
        }
    }
    PERSON_PRIVATE.is_match(&text) && QUERY.is_match(&text)
}

/// User-pasted tool output offered as authority for an operational action.
pub fn untrusted_tool_result_requested(text: &str) -> bool {
    let text = nfkc(text);
    TOOL_RESULT_MARKER.is_match(&text)
        && (UNTRUSTED_SUCCESS_MARKER.is_match(&text) || TREAT_AS_RESULT.is_match(&text))
}
