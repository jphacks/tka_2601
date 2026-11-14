//! Port of `tests/test_door_closure.py` (#85: end the call on the visitor's departure).

use monban_policy::visit_policy::{Purpose, VisitState};

const RULES: &str = "玄関の前に置いてください。";
const FAREWELL: &str = "失礼いたします。";

fn state(text: &str, previous: &[(&str, &str)]) -> VisitState {
    let mut messages = previous.to_vec();
    messages.push(("user", text));
    VisitState::from_messages(&messages, RULES)
}

/// What `DoorAgent.llm_node` says without calling the model, if anything.
fn door_reply_without_model(messages: &[(&str, &str)]) -> Option<String> {
    let state = VisitState::from_messages(messages, RULES);
    if state.closing {
        return Some(state.fallback());
    }
    state.deterministic_reply()
}

#[test]
fn final_thanks_with_unknown_purpose_uses_farewell_without_llm() {
    let messages = [
        ("user", "でも最初答えてたから"),
        ("assistant", "恐れ入りますが、お名前はお伝えできません。"),
        ("user", "大丈夫です"),
        ("assistant", "はい、大丈夫です。"),
        ("user", "ありがとうございました"),
    ];
    let result = VisitState::from_messages(&messages, "");
    assert!(result.closing);
    assert_eq!(door_reply_without_model(&messages).as_deref(), Some(FAREWELL));
    assert!(result.validate(FAREWELL));
}

#[test]
fn clear_departure_variants() {
    for text in [
        "失礼します", "失礼いたします", "はい、失礼いたします。", "では、失礼します。", "ありがとうございました",
        "どうもありがとうございました。", "ありがとうございました。失礼します。", "荷物を置きました。失礼いたします。",
    ] {
        let result = state(text, &[]);
        assert!(result.closing, "{text}");
        assert_eq!(result.fallback(), FAREWELL, "{text}");
    }
}

#[test]
fn present_thanks_during_delivery_is_not_departure() {
    let previous = [("user", "宅急便です"), ("assistant", "玄関の前に置いていただけますか。")];
    for text in ["ありがとう", "ありがとうございます", "どうも", "はい、ありがとうございます。", "置いておきます", "よろしくお願いします"] {
        let result = state(text, &previous);
        assert!(!result.closing, "{text}");
        assert!(!result.placed, "{text}");
        assert!(!result.validate(FAREWELL), "{text}");
    }
}

#[test]
fn new_request_and_quoted_farewell_do_not_close() {
    for text in [
        "ありがとうございました。あと一つ質問です。", "ありがとう、置き場所はどこですか。",
        "失礼しますというかどうすればいいですか", "失礼しますが、サインをお願いします。",
        "先方には「失礼します」と伝えてください", "「ありがとうございました」と言えばいいですか。",
        "ありがとうございましたと伝えてください", "夜分に失礼いたします。宅急便です。",
        "夜分に失礼いたします", "さようならと言われました。", "配達員の発言を引用します。ありがとうございました。",
    ] {
        assert!(!state(text, &[]).closing, "{text}");
    }
}

#[test]
fn explicit_parcel_completion_recovers_unknown_purpose() {
    let previous = [("user", "こんにちは"), ("assistant", "ご用件をお聞かせください。")];
    for text in ["荷物を置きました", "お荷物は玄関の前に置いておきました", "荷物を置いてきました"] {
        let result = state(text, &previous);
        assert_eq!(result.purpose, Purpose::Delivery, "{text}");
        assert!(result.placed, "{text}");
        let mut messages = previous.to_vec();
        messages.push(("user", text));
        assert_eq!(door_reply_without_model(&messages).as_deref(), Some(FAREWELL), "{text}");
    }
}

#[test]
fn nonparcel_placement_does_not_invent_delivery() {
    let result = state("花瓶を置きました", &[]);
    assert!(!result.placed);
    assert_eq!(result.purpose, Purpose::Unknown);
}

#[test]
fn placement_questions_quotes_negatives_and_future_remain_open() {
    let previous = [("user", "宅急便です"), ("assistant", "玄関の前に置いていただけますか。")];
    for text in [
        "まだ置いていません", "まだ置いてないです", "置きません", "これから置きます", "置いておきます",
        "置きましたか", "置いたらいいですか", "置いたことにしてください", "入れたらいいですか",
        "「置きました」とは言っていません", "置きましたと言っていました", "置きましたが、まだ置いていません",
        "荷物を置いたわけではありません", "荷物を置いたことはありません", "荷物を置いたのではありません",
    ] {
        let result = state(text, &previous);
        assert!(!result.placed, "{text}");
        assert!(!result.closing, "{text}");
    }
}

#[test]
fn later_negative_correction_clears_placed() {
    let previous = [("user", "宅急便です"), ("user", "荷物を置きました")];
    for text in ["訂正です、まだ置いていません", "荷物を置いたわけではありません", "荷物を置いたことはありません"] {
        assert!(!state(text, &previous).placed, "{text}");
    }
}

#[test]
fn completed_dropoff_with_outstanding_request_is_not_closed() {
    let previous = [("user", "宅急便です"), ("assistant", "玄関の前に置いてください。")];
    for text in [
        "荷物を置きました。あと伝票にサインをお願いします。", "荷物を置きました。これで大丈夫ですか。",
        "荷物を置きました。サインしてください。", "荷物を置きました。まだ別の荷物があります。",
    ] {
        let result = state(text, &previous);
        assert!(result.placed, "{text}");
        assert!(!result.closing, "{text}");
        assert_ne!(result.deterministic_reply().as_deref(), Some(FAREWELL), "{text}");
        assert_ne!(result.fallback(), FAREWELL, "{text}");
        assert!(!result.validate(FAREWELL), "{text}");
    }
}

#[test]
fn final_thanks_is_not_repeated_after_agent_farewell() {
    let result = state("ありがとうございました", &[("user", "宅急便です"), ("assistant", FAREWELL)]);
    assert!(result.closing_said);
    assert!(result.should_wait());
}

#[test]
fn delivery_labels_follow_the_completed_task() {
    let mut messages = vec![
        ("user", "荷物のお届けに来ました"),
        ("assistant", "玄関の前に置いていただけますか。"),
        ("user", "宅急便です"),
        ("assistant", "はい、玄関の前にお願いします。"),
        ("user", "荷物を置きました"),
    ];
    let result = VisitState::from_messages(&messages, "");
    assert!(result.placed);
    assert_eq!(result.deterministic_reply().as_deref(), Some(FAREWELL));
    messages.extend([("assistant", FAREWELL), ("user", "ありがとうございました")]);
    assert!(VisitState::from_messages(&messages, "").should_wait());
}

#[test]
fn completion_is_not_carried_to_a_new_session() {
    assert!(state("荷物を置きました", &[]).placed);
    let fresh = state("ありがとうございます", &[]);
    assert!(!fresh.placed);
    assert!(!fresh.closing);
}

#[test]
fn a_promise_to_come_back_later_still_ends_the_call() {
    for text in ["あとでまた来ます", "あとで伺います", "また後で来ます", "失礼します。また来ます", "ありがとうございました。また伺います"] {
        assert!(state(text, &[]).closing, "{text}");
    }
}

#[test]
fn a_later_request_or_question_keeps_the_call_open() {
    for text in ["あと、サインをお願いします", "あとひとつ確認したいです", "失礼します。あとで何時に来ればいいですか", "ありがとうございました。あとサインは要りますか"] {
        assert!(!state(text, &[]).closing, "{text}");
    }
}

#[test]
fn promise_to_return_later_closes_like_main() {
    // 「あとで」を追加の用件の「あと」と読み違えてはいけない。
    for text in [
        "あとでまた来ます", "あとで伺います", "失礼します。また来ます", "失礼しますまた来ます",
        "また来ます", "改めて伺います", "後でまた来ます", "ありがとうございました。また来ます",
        "じゃあまた来ますね", "失礼しますね",
    ] {
        let result = state(text, &[]);
        assert!(result.closing, "{text}");
        assert_eq!(result.deterministic_reply().as_deref(), Some(FAREWELL), "{text}");
    }
}

#[test]
fn after_and_desune_still_mark_a_follow_up() {
    for text in ["ありがとうございました。あとですね、サインをお願いします。", "あと、伝票にサインをお願いします。"] {
        assert!(!state(text, &[]).closing, "{text}");
    }
}
