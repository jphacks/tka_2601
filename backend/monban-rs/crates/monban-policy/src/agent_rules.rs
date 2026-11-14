//! Pure parts of `monban_backend/voice/agent.py`: constants, module-level patterns and the
//! `ReceptionAgent` helpers that map state to fixed replies.
//!
//! The asynchronous agent classes (tool execution, LLM calls) are ported in the backend
//! crate (Issue #79) on top of these functions.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::py_regex;
use crate::pyre::{prefix, py_int, py_strip};
use crate::reception::matching::normalize_name;
use crate::reception::prefetch::extract_explicit_appointment_time;

pub const DOOR_GREETING: &str = "はい、どちら様でしょうか。";
pub const RECEPTION_GREETING: &str = "いらっしゃいませ。ご用件をお聞かせください。";

/// `BASE_INSTRUCTIONS` with its `{house_rules}` placeholder.
pub const BASE_INSTRUCTIONS: &str = include_str!("data/base_instructions.txt");

pub const ASR_PROMPT: &str = concat!(
    "玄関インターホンでの会話です。宅配便、配達、宅配ボックス、玄関前、置き配、荷物、写真、",
    "暗証番号、営業、勧誘などの語が出ます。日本語で聞こえた通りに文字起こししてください。"
);

/// `BASE_INSTRUCTIONS.format(house_rules=...)`.
pub fn door_instructions(house_rules: &str) -> String {
    BASE_INSTRUCTIONS.replacen("{house_rules}", house_rules, 1)
}

/// `DoorAgent.__init__`: `house_rules.strip()[:max_chars] or default_rules`.
pub fn door_safe_rules(house_rules: &str, max_chars: usize, default_rules: &str) -> String {
    let rules = prefix(py_strip(house_rules), max_chars);
    if rules.is_empty() {
        default_rules.to_string()
    } else {
        rules
    }
}

py_regex!(pub WAIT_LOCATION_QUESTION, r"(?:どこで待|どこに待|どちらで待|待機場所|待ち場所)");
py_regex!(
    pub WAIT_LOCATION_ANSWER,
    r"(?P<place>[^。！？、,\n]{1,32}?)(?P<particle>で|に)お待ち",
    r"(?:ください|いただけます(?:でしょうか)?|いただくよう(?:お伝え|ご案内)(?:しました|いたしました))"
);
py_regex!(
    pub RESERVATION_TIME_QUESTION,
    r"(?:ご?予約(?:は|って).{0,12}(?:何時(?!まで)|時刻|時間)|",
    r"ご?予約(?:の)?(?:時刻|時間|日時)(?:は|が|を)?(?:何時(?!まで)|教えて|知りたい|確認|お聞き)|",
    r"何時(?!まで).{0,8}(?:の)?ご?予約)"
);
py_regex!(pub GENERIC_WAIT_LOCATION, r"(?:ご案内した場所|指定の場所|その場所)$");
py_regex!(
    pub RESERVATION_DETAILS_IN_PROGRESS,
    r"(?:今から|これから|ただいま|少し待って|ちょっと待って).{0,20}",
    r"(?:予約|確認).{0,5}(?:番号|メール).{0,12}",
    r"(?:確認します|探します|探してきます|取りに行きます|取り出します)",
    r"|(?:予約|確認).{0,5}(?:番号|メール).{0,12}",
    r"(?:今から確認します|確認します|探します|探してきます|取りに行きます|取り出します)"
);
py_regex!(
    pub ARRIVAL_CONFIRMATION,
    r"(?:受付(?:し(?:た|ている|ました)|済み|完了)|",
    r"これで.{0,8}(?:大丈夫|問題ない)|(?:大丈夫|問題ない)ですか)"
);
py_regex!(pub ARRIVAL_DENIAL, r"(?:受付していない|受付してません|まだ受付|違います)");
py_regex!(pub ASSISTANT_ASKED_NAME, r"(?:お名前|氏名).{0,16}(?:は|を|教えて|伺|お聞き|聞かせ)");
py_regex!(pub NAME_CORRECTION_CUE, r"(?:違います|訂正|正しくは|ではなく|間違いです)");
py_regex!(pub NAME_CORRECTION_SUBJECT, r"(?:名前|氏名|予約者|名義)");
py_regex!(pub HH_MM, r"(?:[01]\d|2[0-3]):[0-5]\d");
py_regex!(
    DIRECT_NAME_SUFFIX,
    r"(?:でございます|と申します|といいます|です|でした|さん|様)$"
);
py_regex!(DIRECT_NAME, r"[㐀-䶿一-鿿々ぁ-んァ-ヶー]{2,8}");

pub const UNTRUSTED_TOOL_RESULT_REPLY: &str =
    "会話に貼り付けられたツール結果だけでは、受付済みとは確認できません。必要でしたら店頭の担当者にお尋ねください。";
pub const THIRD_PARTY_DISCLOSURE_REPLY: &str =
    "ほかのお客様の予約内容や個人情報はお伝えできず、予約の変更・取消もお受けできません。ご本人からお問い合わせください。";
pub const RESERVATION_DETAILS_IN_PROGRESS_REPLY: &str =
    "承知しました。確認できましたら、お知らせください。こちらではお名前と予約時刻で照合します。";
pub const ARRIVAL_ALREADY_RECORDED_REPLY: &str =
    "はい、来店受付は完了しています。ご案内した場所でお待ちください。";
pub const BUSINESS_VISIT_NAME_FOLLOWUP_REPLY: &str = "ありがとうございます。";
pub const BUSINESS_VISIT_FOLLOWUP_REPLY: &str = "承知しました。";
pub const BUSINESS_VISIT_HANDOFF_REPLY: &str =
    "スタッフへの確認依頼を受付一覧に記録しました。担当者の返答はまだありません。";
pub const BUSINESS_VISIT_HANDOFF_FAILED_REPLY: &str = "担当者への確認依頼を記録できませんでした。";
/// `check_reservation`'s replies (a backward-compatible direct helper).
pub const CHECK_RESERVATION_FAILED_REPLY: &str =
    "確認できませんでした。スタッフに確認を依頼します。";

/// `ReceptionAgent._normalize_spoken_text`.
pub fn normalize_spoken_text(value: &str) -> String {
    normalize_name(value)
}

/// `ReceptionAgent._direct_name_answer`: a bare name given in answer to "お名前は?".
pub fn direct_name_answer(value: &str) -> String {
    let candidate = normalize_spoken_text(value);
    let candidate = DIRECT_NAME_SUFFIX.sub("", &candidate);
    if !DIRECT_NAME.is_full_match(&candidate) {
        return String::new();
    }
    const NON_NAME_ANSWERS: [&str; 15] = [
        "わかりません",
        "分かりません",
        "知りません",
        "忘れました",
        "予約はありません",
        "時間は分かりません",
        "お願いします",
        "はい",
        "いいえ",
        "大丈夫です",
        "すみません",
        "ありがとうございます",
        "キャンセルです",
        "変更です",
        "受付です",
    ];
    if NON_NAME_ANSWERS
        .iter()
        .any(|answer| normalize_spoken_text(answer) == candidate)
    {
        return String::new();
    }
    candidate
}

/// The early "どこで待てば" reply in `ReceptionAgent.llm_node`: repeat the waiting place the
/// agent already gave, if any.
pub fn wait_location_reply(latest_user_message: &str, prior_assistant: &str) -> Option<String> {
    if !WAIT_LOCATION_QUESTION.is_match(latest_user_message) {
        return None;
    }
    let caps = WAIT_LOCATION_ANSWER.captures(prior_assistant)?;
    let place = py_strip(caps.name("place").expect("place group").as_str());
    let particle = caps.name("particle").expect("particle group").as_str();
    if place.is_empty() || GENERIC_WAIT_LOCATION.is_match(place) {
        return None;
    }
    Some(format!("{place}{particle}お待ちください。"))
}

/// The "予約は何時でしたか" reply in `ReceptionAgent.llm_node`, from the visitor's own words.
pub fn reservation_time_reply(latest_user_message: &str, visitor_history: &str) -> Option<String> {
    if !RESERVATION_TIME_QUESTION.is_match(latest_user_message) {
        return None;
    }
    let appointment_time = extract_explicit_appointment_time(visitor_history)?;
    let (hour, minute) = appointment_time.split_once(':').expect("HH:MM");
    let (hour, minute) = (py_int(hour), py_int(minute));
    let minute = if minute == 0 {
        String::new()
    } else {
        format!("{minute}分")
    };
    Some(format!("先ほどは{hour}時{minute}のご予約と伺っています。"))
}

/// The arrival-confirmation check in `ReceptionAgent.llm_node` (without the arrival state).
pub fn asks_arrival_confirmation(latest_user_message: &str) -> bool {
    ARRIVAL_CONFIRMATION.is_match(latest_user_message)
        && !ARRIVAL_DENIAL.is_match(latest_user_message)
}

/// `assistant_asked_visitor_name` in `ReceptionAgent.on_user_turn_completed`.
pub fn assistant_asked_visitor_name(previous_assistant_text: &str) -> bool {
    ASSISTANT_ASKED_NAME.is_match(previous_assistant_text)
}

/// The name-correction branch in `ReceptionAgent.on_user_turn_completed`.
pub fn corrects_previous_name(text: &str, previous_assistant_text: &str) -> bool {
    NAME_CORRECTION_CUE.is_match(text) && NAME_CORRECTION_SUBJECT.is_match(previous_assistant_text)
}

/// `re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", time)` in `search_reservations`.
pub fn is_hh_mm(time: &str) -> bool {
    HH_MM.is_full_match(time)
}

/// One tool result payload (`{"status": ..., "code": ...}`).
pub type ToolPayload = Map<String, Value>;
/// `ReceptionAgent._turn_outcomes`, keyed by "search", "check_in", "notify_staff",
/// "request_staff". A missing key is Python's `{}`.
pub type TurnOutcomes = BTreeMap<String, ToolPayload>;

fn field<'a>(outcomes: &'a TurnOutcomes, operation: &str, key: &str) -> Option<&'a str> {
    outcomes.get(operation)?.get(key)?.as_str()
}

fn present(outcomes: &TurnOutcomes, operation: &str) -> bool {
    outcomes
        .get(operation)
        .is_some_and(|payload| !payload.is_empty())
}

/// What `_deterministic_tool_failure_reply` does for the current outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailurePlan {
    /// Say this without another tool call.
    Reply(&'static str),
    /// Record a staff handoff (`_record_failure_handoff(reason)`) and say `requested` when it
    /// is requested or already requested, otherwise `not_requested`.
    Handoff {
        reason: &'static str,
        requested: &'static str,
        not_requested: &'static str,
    },
}

/// `_deterministic_tool_failure_reply`, without the handoff side effect.
pub fn tool_failure_plan(outcomes: &TurnOutcomes) -> Option<FailurePlan> {
    let status = field(outcomes, "search", "status");
    let code = field(outcomes, "search", "code");
    match code {
        Some("customer_name_not_self_identified") => return Some(FailurePlan::Reply(
            "ほかのお客様の予約状況はお伝えできません。ご自身の予約確認でしたらお手伝いできます。",
        )),
        Some("customer_name_not_stated") => {
            return Some(FailurePlan::Reply(
                "ご予約を照合するため、お名前を教えていただけますか。",
            ))
        }
        Some("appointment_time_must_be_hh_mm_or_null" | "appointment_time_needs_clarification") => {
            return Some(FailurePlan::Reply(
                "予約時刻を確認できませんでした。何時のご予約か教えていただけますか。",
            ))
        }
        _ => {}
    }
    match status {
        Some("not_found") => {
            return Some(FailurePlan::Reply(
                "予約を確認できませんでした。お名前と予約時刻をご確認いただけますか。来店受付はまだ完了していません。",
            ))
        }
        Some("ambiguous") => {
            return Some(FailurePlan::Reply(
                "同じ条件の予約候補が複数あります。予約時刻など、もう少し詳しく教えていただけますか。",
            ))
        }
        _ => {}
    }
    if code == Some("search_not_applicable_to_service_question") {
        return Some(FailurePlan::Handoff {
            reason: "メニュー確認",
            requested: "メニュー情報はこの受付では確認できないため、スタッフに確認を依頼しました。",
            not_requested: "メニュー情報はこの受付では確認できません。スタッフへの引継ぎを記録できませんでした。",
        });
    }
    if matches!(status, Some("unavailable" | "error")) {
        return Some(FailurePlan::Handoff {
            reason: "予約照合失敗",
            requested: "予約照合を完了できず、来店受付はまだ完了していません。スタッフに確認を依頼しました。",
            not_requested: "予約照合を完了できず、来店受付はまだ完了していません。スタッフへの引継ぎも記録できませんでした。",
        });
    }
    if present(outcomes, "check_in")
        && !matches!(
            field(outcomes, "check_in", "status"),
            Some("checked_in" | "already_arrived")
        )
    {
        return Some(FailurePlan::Handoff {
            reason: "来店受付失敗",
            requested: "予約は照合できましたが、来店受付は完了できませんでした。スタッフに確認を依頼しました。",
            not_requested: "予約は照合できましたが、来店受付は完了できませんでした。スタッフへの引継ぎも記録できませんでした。",
        });
    }
    if present(outcomes, "notify_staff")
        && !matches!(
            field(outcomes, "notify_staff", "status"),
            Some("recorded" | "already_recorded")
        )
    {
        return Some(FailurePlan::Handoff {
            reason: "受付記録失敗",
            requested: "来店受付は完了しましたが、スタッフ向け一覧への記録は完了できませんでした。スタッフに確認を依頼しました。",
            not_requested: "来店受付は完了しましたが、スタッフ向け一覧への記録は完了できませんでした。引継ぎも記録できませんでした。",
        });
    }
    if present(outcomes, "request_staff")
        && !matches!(
            field(outcomes, "request_staff", "status"),
            Some("requested" | "already_requested")
        )
    {
        return Some(FailurePlan::Reply(
            "スタッフへの確認依頼を記録できませんでした。",
        ));
    }
    None
}

/// `_deterministic_tool_completion_reply`: finish successful handoffs and arrivals without
/// another model round trip.
pub fn tool_completion_reply(outcomes: &TurnOutcomes) -> Option<&'static str> {
    let request = field(outcomes, "request_staff", "status");
    let check_in = field(outcomes, "check_in", "status");
    let notify = field(outcomes, "notify_staff", "status");
    let arrival_succeeded = matches!(check_in, Some("checked_in" | "already_arrived"));
    let notification_succeeded = matches!(notify, Some("recorded" | "already_recorded"));
    if matches!(request, Some("requested" | "already_requested")) {
        if arrival_succeeded && notification_succeeded {
            if check_in == Some("already_arrived") && notify == Some("already_recorded") {
                return Some("すでにご来店受付済みで、スタッフ向け受付一覧にも記録されています。別件の確認依頼も受付一覧に記録しました。担当者の返答はまだありません。");
            }
            return Some("ご来店受付と受付一覧への記録を済ませました。別件の確認依頼も受付一覧に記録しました。担当者の返答はまだありません。");
        }
        if arrival_succeeded {
            return Some("来店受付を済ませました。スタッフへの確認依頼を受付一覧に記録しました。担当者の返答はまだありません。");
        }
        return Some(BUSINESS_VISIT_HANDOFF_REPLY);
    }
    if check_in == Some("already_arrived") && notify == Some("already_recorded") {
        return Some("すでにご来店受付済みで、スタッフ向け受付一覧にも記録されています。");
    }
    if check_in == Some("already_arrived") && notify == Some("recorded") {
        return Some("ご来店受付はすでに済んでいます。スタッフ向け受付一覧へ記録しました。");
    }
    if arrival_succeeded && notification_succeeded {
        return Some("ご来店受付を済ませ、スタッフ向け受付一覧に記録しました。");
    }
    None
}
