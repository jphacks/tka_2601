//! Port of `monban_backend/reception/tool_schema.py` (the shared reception text policy and
//! the earlier three-tool contract).

use std::sync::LazyLock;

use serde_json::Value;

use super::business_visits::classify_business_visit;
use crate::py_regex;
use crate::pyre::{casefold, nfkc, PyRegex};

py_regex!(
    pub SERVICE_INFO_QUERY,
    r"(?:メニュー|施術内容|コース内容|料金|値段|価格|金額|キャンセル料|営業時間|店舗ルール)"
);
py_regex!(
    pub HOURS_INFORMATION_QUERY,
    r"(?:営業時間|閉店時刻|営業終了時刻|何時まで(?:開いて|営業|受付)|",
    r"何時から(?:開いて|営業)|営業日|定休日)"
);
py_regex!(
    pub ARRIVAL_INTENT,
    r"(?:来店|到着|着きました|着いた|入店|チェックイン|受付(?:を|して|お願いします|したい))"
);
py_regex!(
    pub RESERVATION_MENU_QUERY,
    r"(?:",
    r"予約(?:を)?(?:お願い(?:した|している|しています|しました|してます)|",
    r"(?:し|して)(?:た|いる|います|ます|る)|",
    r"取(?:った|りました|っている|っています)|",
    r"入れ(?:た|ました|ている|ています)|済み)|",
    r"予約(?:が)?入って(?:いる|います|る|ます)|",
    r"予約の",
    r")"
);
py_regex!(
    pub NO_RESERVATION_QUERY,
    r"(?:予約(?:(?:は|が|を)?\s*(?:まだ)?\s*(?:ありません|ない|なし|していません|してない|してなくて|しておらず|せず))|予約なし)"
);
py_regex!(pub MENU_INFORMATION_QUERY, r"(?:メニュー|施術内容|コース(?:内容)?|施術プラン|プラン)");
py_regex!(
    pub UNSUPPORTED_RESERVATION_ACTION,
    r"(?:予約.{0,16}(?:変更|キャンセル|取消|取り消し|新規|追加)|",
    r"(?:変更|キャンセル|取消|取り消し).{0,16}予約|予約を?(?:変更|キャンセル|取消|取り消し)|解錠|開錠)"
);
py_regex!(pub APPOINTMENT_TIME, r"(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:半|[0-5]?\d分?)?)");
py_regex!(
    pub DIRECT_HANDOFF_REQUEST,
    r"(?:スタッフ|担当者|担当の方).{0,12}(?:確認|相談|聞|伝え|依頼|取り次ぎ)"
);
py_regex!(
    pub EARLY_ARRIVAL_WAIT_QUERY,
    r"(?:",
    r"(?:早く|早めに|予約.{0,8}より.{0,8}早く).{0,12}(?:着|到着)|",
    r"早着|どこで待|どこに待|どちらで待|待てば|待機すれば|店内で待|待機場所|待ち場所",
    r")"
);
py_regex!(
    pub THIRD_PARTY_BOOKING_QUERY,
    r"(?:他の方|別の方|ほかのお客様|他のお客様|他人|同僚|友人|家族).{0,10}(?:予約|来店予定)",
    r"|[぀-ヿ㐀-鿿ー]{1,12}(?:さん|様|氏)の(?:ご?予約|予約内容|予約時刻|予約時間|予約が|予約は)",
    r"|(?:付き添い|同伴|同行).{0,20}(?:予約|メニュー)|本人の(?:ご?予約|予約内容|予約時刻|メニュー)"
);
py_regex!(
    pub STAFF_HANDOFF_QUERY,
    r"(?:",
    r"予約.{0,8}(?:変更|キャンセル|取消|取り消し|新規|追加)|",
    r"変更|追加|キャンセル|取消|取り消し|解錠|開錠|鍵を|遅刻|遅れ|延長|",
    r"預かり|預かっ|預かる|預け|保管|受け取り|受取|",
    r"リュック|鞄|かばん|カバン|バッグ|置き場所|置く場所|置ける場所|どこに置|置いても|置かせて|",
    r"待機場所|待ち場所|待っている|待てば|待機すれば|どこで待|どこに待|どちらで待|店内で待|早着|予約なし|予約はありません|飛び込み|",
    r"着替え|上着|持ち物|荷物|伝言|段差|車いす|画像|受け入れ|マット|コンタクト|必要|",
    r"症状|痛み|しびれ|アレルギー|妊娠|体調|",
    r"(?:担当者|スタッフ|人に).{0,12}(?:確認|相談|伝え|聞い)|",
    r"確認して(?:ください|もらえますか|ほしい)|確認をお願いします|相談したい|伝言を",
    r")"
);

py_regex!(NAME_PUNCTUATION, r"[\s、。,.！!？?「」『』（）()・：:]+");
py_regex!(HONORIFIC_SUFFIX, r"(?:さん|様|氏)$");
py_regex!(STAFF_REASON_PUNCTUATION, r"[\s、。,.！!？?]+");

/// `customer_name_is_self_identified`: the queried name is presented as the visitor's own.
pub fn customer_name_is_self_identified(user_text_history: &str, customer_name: &str) -> bool {
    let text = NAME_PUNCTUATION.sub("", &nfkc(user_text_history));
    let name = NAME_PUNCTUATION.sub("", &nfkc(customer_name));
    let name = HONORIFIC_SUFFIX.sub("", &name);
    if name.is_empty() || !text.contains(&name) {
        return false;
    }
    let escaped = py_escape(&name);
    let suffix = r"(?:さん|様)?(?:です|でございます|と申します|といいます|本人です)";
    let patterns = [
        format!(r"(?:私|わたし|僕|ぼく|本人)?(?:は|が)?{escaped}{suffix}"),
        format!(r"(?:私|わたし|僕|ぼく|本人)?(?:は|が)?{escaped}[぀-ヿ㐀-鿿ー]{{1,4}}{suffix}"),
        format!(
            r"(?:[01]?\d|2[0-3])(?::[0-5]\d|時(?:半|[0-5]?\d分?)?)(?:の予約で|の)?{escaped}{suffix}"
        ),
        format!(
            r"(?:予約(?:した|をした|している|しています)|来店した)(?:のは|者は)?{escaped}{suffix}"
        ),
        format!(r"(?:名前|お名前|氏名|予約者)(?:は|が)?{escaped}{suffix}"),
        format!(
            r"(?:予約名|予約者|予約をした名前)(?:は|が){escaped}(?:さん|様)?(?:です|でした|でお願いします)?"
        ),
        format!(
            r"{escaped}(?:さん|様)?(?:の名前で|名義で)予約(?:しています|しました|をしています|をしました)"
        ),
    ];
    patterns
        .iter()
        .any(|pattern| PyRegex::new(pattern).is_match(&text))
}

/// `re.escape` for a literal inside a pattern. Python escapes `()[]{}?*+-|^$\.&~#` and
/// whitespace; a hex escape matches the same single character in fancy-regex.
pub(crate) fn py_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if "()[]{}?*+-|^$\\.&~# \t\n\r\u{b}\u{c}".contains(c) {
            out.push_str(&format!("\\x{{{:x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

pub fn search_is_applicable(user_message_history: &str) -> bool {
    if classify_business_visit(user_message_history).is_some() {
        return false;
    }
    let early_arrival_wait = EARLY_ARRIVAL_WAIT_QUERY.is_match(user_message_history);
    let arrival = ARRIVAL_INTENT.is_match(user_message_history);
    let service_info_only = SERVICE_INFO_QUERY.is_match(user_message_history) && !arrival;
    !service_info_only
        && !early_arrival_wait
        && !THIRD_PARTY_BOOKING_QUERY.is_match(user_message_history)
        && (!UNSUPPORTED_RESERVATION_ACTION.is_match(user_message_history) || arrival)
}

/// Menu information about a visitor's own existing reservation.
pub fn is_reservation_menu_query(user_message: &str, conversation_history: &str) -> bool {
    let text = nfkc(user_message);
    let context = nfkc(if conversation_history.is_empty() {
        &text
    } else {
        conversation_history
    });
    MENU_INFORMATION_QUERY.is_match(&text)
        && RESERVATION_MENU_QUERY.is_match(&context)
        && !NO_RESERVATION_QUERY.is_match(&context)
        && !THIRD_PARTY_BOOKING_QUERY.is_match(&text)
}

/// A reservation-menu question needs the appointment time before the agent continues.
pub fn menu_query_needs_time(user_message: &str, conversation_history: &str) -> bool {
    let text = nfkc(user_message);
    let context = nfkc(if conversation_history.is_empty() {
        &text
    } else {
        conversation_history
    });
    is_reservation_menu_query(&text, &context)
        && !APPOINTMENT_TIME.is_match(&context)
        && !DIRECT_HANDOFF_REQUEST.is_match(&text)
        && !STAFF_HANDOFF_QUERY.is_match(&text)
}

/// Expose staff handoff only for a current request that needs human judgment.
pub fn staff_handoff_required(user_message: &str, conversation_history: &str) -> bool {
    if classify_business_visit(user_message).is_some() {
        return true;
    }
    if menu_query_needs_time(user_message, conversation_history) {
        return false;
    }
    if HOURS_INFORMATION_QUERY.is_match(user_message)
        && !DIRECT_HANDOFF_REQUEST.is_match(user_message)
    {
        return false;
    }
    SERVICE_INFO_QUERY.is_match(user_message) || STAFF_HANDOFF_QUERY.is_match(user_message)
}

/// A stable idempotency key for a staff request within one session.
pub fn normalize_staff_reason(reason: &str) -> String {
    STAFF_REASON_PUNCTUATION.sub("", &casefold(&nfkc(reason)))
}

/// State for the earlier three-tool contract's [`available_tools`].
#[derive(Debug, Clone, Default)]
pub struct ToolAvailability<'a> {
    pub search_attempted: bool,
    pub arrival_attempted: bool,
    pub request_staff_attempted: bool,
    pub confirmed_reservation: bool,
    pub arrival_recorded: bool,
    pub latest_user_message: &'a str,
    pub request_staff_available: bool,
}

/// `available_tools`: keep only the tool names valid for the current reception state.
pub fn available_tools<'n>(tools: &[&'n str], state: &ToolAvailability<'_>) -> Vec<&'n str> {
    let search_applicable = search_is_applicable(state.latest_user_message);
    tools
        .iter()
        .copied()
        .filter(|name| match *name {
            "search_reservations" => {
                !state.search_attempted
                    && !state.confirmed_reservation
                    && !state.arrival_recorded
                    && search_applicable
            }
            "complete_arrival" => {
                state.confirmed_reservation && !state.arrival_recorded && !state.arrival_attempted
            }
            "request_staff" => !state.request_staff_attempted && state.request_staff_available,
            _ => true,
        })
        .collect()
}

/// `TOOLS`: the earlier three-tool contract in OpenAI tool format.
pub static TOOLS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/tools_v16.json")).expect("valid tools_v16.json")
});

/// `TOOL_SCHEMAS[name]`: the `function` object of a tool in [`TOOLS`].
pub fn tool_schema(name: &str) -> Option<&'static Value> {
    function_by_name(&TOOLS, name)
}

pub(crate) fn function_by_name<'a>(tools: &'a Value, name: &str) -> Option<&'a Value> {
    tools.as_array()?.iter().find_map(|tool| {
        let function = tool.get("function")?;
        (function.get("name")?.as_str()? == name).then_some(function)
    })
}
