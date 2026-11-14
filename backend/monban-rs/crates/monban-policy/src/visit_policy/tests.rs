//! Cases from tests/test_visit_policy.py and tests/test_conversation_scenarios.py.

use super::*;
use crate::house_rules::{base_rules, Mode};

fn state(turns: &[&str]) -> VisitState {
    let messages: Vec<(&str, &str)> = turns.iter().map(|text| ("user", *text)).collect();
    VisitState::from_messages(&messages, "")
}

fn conversation(messages: &[(&str, &str)], rules: &str) -> VisitState {
    VisitState::from_messages(messages, rules)
}

fn reply(state: &VisitState) -> Option<String> {
    state.deterministic_reply()
}

fn normal() -> String {
    base_rules(Mode::Normal, false)
}

#[test]
fn delivery_only_uses_house_rules_for_confirmed_parcel() {
    assert!(state(&["宅配便です"]).delivery_allowed());
    assert!(!state(&["NHKの集金です"]).delivery_allowed());
    assert!(!state(&["営業で来ました"]).delivery_allowed());
}

#[test]
fn payment_and_sales_reject_inappropriate_reply() {
    assert_eq!(state(&["集金に来ました"]).purpose, Purpose::Payment);
    assert!(!state(&["集金に来ました"]).validate("宅配ボックスに入れてください。"));
    assert!(state(&["営業で来ました"])
        .fallback()
        .starts_with("申し訳ありません"));
}

#[test]
fn correction_overrides_delivery_context() {
    let result = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "宅配ボックスへお願いします"),
            ("user", "荷物ではありません"),
        ],
        "",
    );
    assert!(result.no_parcel);
    assert!(!result.delivery_allowed());
    assert!(!result.validate("荷物と置き場所の写真を撮ってください。"));
}

#[test]
fn filler_and_incomplete_phrase_wait_for_more_audio() {
    assert!(state(&["えっと"]).should_wait());
    assert!(state(&["それが終わったら"]).should_wait());
    assert!(!state(&["宅配便です"]).should_wait());
}

#[test]
fn completion_state_is_session_scoped_and_validated() {
    let result = state(&[
        "宅配便です",
        "そこに置きました",
        "写真も撮りました。これで大丈夫ですか?",
    ]);
    assert!(result.placed && result.photographed);
    assert!(result.validate("ありがとうございます。"));
    assert!(!result.validate("解錠しました。"));
    assert!(result.validate("はい、大丈夫です。"));
    assert!(!result.validate("玄関の鍵を開けます。"));
}

#[test]
fn farewell_is_not_repeated_after_it_was_said() {
    let result = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "承知いたしました。失礼いたします。"),
            ("user", "はい失礼します"),
        ],
        "",
    );
    assert!(result.closing && result.closing_said);
    assert!(result.should_wait());
}

#[test]
fn new_request_after_farewell_is_still_answered() {
    let result = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "承知いたしました。失礼いたします。"),
            ("user", "すみません、クール便でした"),
        ],
        "",
    );
    assert!(result.closing_said);
    assert!(!result.should_wait());
}

#[test]
fn delivery_announcement_and_placement_question_get_direct_replies() {
    let mut turns: Vec<(&str, String)> = vec![
        ("user", "こんにちは".into()),
        ("assistant", "どちらの用件でいらっしゃいましたか。".into()),
        ("user", "宅配できました".into()),
        ("assistant", "玄関の前に置いていただけますか。".into()),
        ("user", "じゃあ置いていきますね".into()),
    ];
    let placing = VisitState::from_messages(&turns, "");
    assert!(placing.delivery_allowed() && placing.visitor_will_place && !placing.placed);
    assert_eq!(
        reply(&placing).as_deref(),
        Some("はい、玄関の前にお願いいたします。")
    );

    turns.push(("assistant", reply(&placing).unwrap()));
    turns.push(("user", "どうやっていけば大丈夫ですか?".into()));
    let question = VisitState::from_messages(&turns, "");
    let expected = "はい、玄関の前に置いていただければ大丈夫です。";
    assert_eq!(reply(&question).as_deref(), Some(expected));
    assert!(question.validate(expected));

    turns.push(("assistant", "失礼いたします。".into()));
    turns.push(("user", "失礼しますというかどうすればいいですか".into()));
    let follow_up = VisitState::from_messages(&turns, "");
    assert!(!follow_up.closing);
    assert_eq!(reply(&follow_up).as_deref(), Some(expected));
}

#[test]
fn recognizes_asr_variant_of_delivery_announcement_and_confirmation() {
    let announced = state(&["宅配できました"]);
    assert!(announced.delivery_allowed());
    assert_eq!(
        reply(&announced).as_deref(),
        Some("恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。")
    );
    let confirmed = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "玄関前にお願いします"),
            ("user", "置いておいてば大丈夫ですか"),
        ],
        "",
    );
    assert_eq!(
        reply(&confirmed).as_deref(),
        Some("はい、玄関の前に置いていただければ大丈夫です。")
    );
    let acknowledgement = conversation(
        &[
            ("user", "宅配できました"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "ありがとうございました"),
        ],
        "",
    );
    assert_eq!(
        reply(&acknowledgement).as_deref(),
        Some("はい、よろしくお願いいたします。")
    );
}

#[test]
fn deterministic_placement_reply_uses_the_location_already_requested() {
    let result = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "宅配ボックスに入れていただけますか"),
            ("user", "ここに入れて大丈夫ですか"),
        ],
        "",
    );
    assert_eq!(
        reply(&result).as_deref(),
        Some("はい、宅配ボックスに入れていただければ大丈夫です。")
    );
}

#[test]
fn placement_intention_is_not_mistaken_for_completion_or_farewell() {
    let result = state(&[
        "宅配便です",
        "玄関の前に置いていただけますか",
        "じゃあ置いていきますね",
    ]);
    assert!(result.visitor_will_place && !result.placed && !result.closing);
    assert!(!result.validate("失礼いたします。"));
}

#[test]
fn farewell_must_be_the_end_of_reply() {
    let result = state(&["失礼します"]);
    assert!(!result.validate("承知しました。失礼いたします。ほかに何かありますか？"));
    assert_eq!(result.fallback(), "失礼いたします。");
    let completed = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか"),
            ("user", "置きました"),
            ("assistant", "写真もお願いします"),
            ("user", "写真も撮りました"),
        ],
        "",
    );
    let clipped = completed.trim_after_farewell("失礼いたします。ほかに何かありますか？");
    assert_eq!(clipped, "失礼いたします。");
    assert!(completed.validate(&clipped));
}

#[test]
fn payment_refusal_does_not_carry_over_to_circular_board() {
    let result = conversation(
        &[
            ("user", "NHKの集金なんですけど"),
            (
                "assistant",
                "このインターホンではお支払いに対応できません。",
            ),
            ("user", "すいません、回覧版なんですけど"),
            ("assistant", "回覧板はポストに入れてください。"),
            ("user", "回覧板はどこに置けばいいですか?"),
        ],
        "",
    );
    assert_eq!(result.purpose, Purpose::CircularBoard);
    let expected = "回覧板はポストに入れてください。入らない場合はお知らせください。";
    assert_eq!(reply(&result).as_deref(), Some(expected));
    assert!(result.validate(expected));
    assert!(!result.fallback().contains("お支払い"));
}

#[test]
fn name_confirmation_and_correction_after_reflection() {
    for answer in ["はい大場です", "大葉じゃなくて大場です"] {
        let result = conversation(
            &[
                ("assistant", "大葉様ですね。どのようなご用件でしょうか。"),
                ("user", answer),
            ],
            "",
        );
        assert!(result.name_confirmation, "{answer}");
        assert_eq!(
            reply(&result).as_deref(),
            Some("失礼しました。お名前の確認ありがとうございます。")
        );
    }
}

#[test]
fn presence_question_does_not_disclose_resident_status() {
    let result = state(&["今いらっしゃいますか"]);
    assert!(result.presence_question);
    let expected = "住人の在宅状況はお伝えできません。ご用件をお聞かせください。";
    assert_eq!(reply(&result).as_deref(), Some(expected));
    assert!(result.validate(expected));
    assert!(!result.validate("はい、在宅しています。"));
}

#[test]
fn unknown_follow_up_does_not_get_generic_intercom_refusal() {
    let result = conversation(
        &[
            ("assistant", "どのようなご用件でしょうか。"),
            ("user", "ちょっと聞きたいことがあるんですけど"),
        ],
        "",
    );
    assert_eq!(
        result.fallback(),
        "恐れ入りますが、もう少し詳しくお聞かせください。"
    );
}

#[test]
fn circular_board_rules() {
    let no_fit = conversation(
        &[
            ("user", "回覧板です"),
            ("assistant", "回覧板はポストに入れてください。"),
            ("user", "ポストに入らないです"),
        ],
        "",
    );
    assert_eq!(
        reply(&no_fit).as_deref(),
        Some("ポストに入らない場合は、どちらに置けばよろしいでしょうか。")
    );
    let resident_rule = conversation(
        &[("user", "回覧板はどこに置けばいいですか?")],
        "回覧板は玄関前に置いてください。",
    );
    assert_eq!(reply(&resident_rule), None);
    assert!(resident_rule.validate("回覧板は玄関前に置いてください。"));
}

#[test]
fn photo_how_to_follow_up_gets_answer_even_after_farewell() {
    let result = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "置きました"),
            ("assistant", "荷物と置き場所の写真を撮ってください。"),
            ("user", "写真撮りました"),
            ("assistant", "失礼いたします。"),
            ("user", "撮った写真はどうしたらいいですか"),
        ],
        "",
    );
    let expected = "こちらへの写真の撮影や送付は不要です。配達会社の手順に従ってください。";
    assert_eq!(reply(&result).as_deref(), Some(expected));
    assert!(result.validate(expected));
}

#[test]
fn placement_question_and_photo_requests() {
    let result = conversation(
        &[("user", "配達です"), ("user", "どこに置いたらいいですか？")],
        "玄関の前に置いてください",
    );
    assert!(!result.placed);
    let placed = state(&["配達です", "置きました"]);
    for request in [
        "荷物と置き場所の写真を撮ってください。",
        "写真を送ってください。",
        "写真を保管してください。",
        "撮影してください。",
    ] {
        assert!(!placed.validate(request), "{request}");
    }
}

#[test]
fn common_delivery_announcements_get_a_house_rule_reply() {
    for announcement in ["宅配便です", "荷物です", "ヤマト運輸です", "佐川急便です"]
    {
        let result = conversation(
            &[
                ("assistant", "はい、どちら様でしょうか。"),
                ("user", announcement),
            ],
            &normal(),
        );
        assert_eq!(result.purpose, Purpose::Delivery);
        let expected = "恐れ入りますが、玄関の前に置いていただけますか。";
        assert_eq!(reply(&result).as_deref(), Some(expected));
        assert!(result.validate(expected));
    }
}

#[test]
fn explicit_purpose_corrections_select_the_corrected_topic() {
    for correction in ["営業じゃなくて宅配便です", "集金ではなく宅配便です"]
    {
        let result = conversation(&[("user", correction)], &normal());
        assert_eq!(result.purpose, Purpose::Delivery);
        assert_eq!(
            reply(&result).as_deref(),
            Some("恐れ入りますが、玄関の前に置いていただけますか。")
        );
    }
    let multi = conversation(
        &[
            ("user", "NHKの集金です"),
            (
                "assistant",
                "このインターホンではお支払いに対応できません。",
            ),
            ("user", "すみません、集金ではなく宅配便です"),
        ],
        &normal(),
    );
    assert_eq!(multi.purpose, Purpose::Delivery);
    assert!(reply(&multi).unwrap().contains("玄関の前"));
}

#[test]
fn full_delivery_box_switches_to_the_configured_alternate_location() {
    let rules = "宅配ボックスを優先し、入らない場合は玄関前に置いてください。";
    let result = conversation(
        &[
            ("user", "宅配便です"),
            (
                "assistant",
                "恐れ入りますが、宅配ボックスに入れていただけますか。",
            ),
            ("user", "宅配ボックスがいっぱいでした"),
        ],
        rules,
    );
    assert_eq!(result.requested_delivery_location, Some(LOCATION_FRONT));
    assert_eq!(
        reply(&result).as_deref(),
        Some("宅配ボックスに入らない場合は、玄関の前に置いていただけますか。")
    );
}

#[test]
fn delivery_slip_cases() {
    let away = conversation(&[("user", "宅配便です")], &base_rules(Mode::Away, false));
    assert_eq!(
        reply(&away).as_deref(),
        Some("恐れ入りますが、不在票を入れていただけますか。")
    );
    for utterance in ["クール便です", "宅配便ですが代引きです"] {
        let result = conversation(&[("user", utterance)], &normal());
        assert!(result.delivery_allowed() && result.delivery_unavailable);
        assert_eq!(
            reply(&result).as_deref(),
            Some("恐れ入りますが、不在票を入れていただけますか。")
        );
    }
}

#[test]
fn natural_placement_confirmations_get_a_direct_yes() {
    for confirmation in [
        "玄関前でいいですか？",
        "玄関の前で大丈夫ですか？",
        "ここに置いて大丈夫ですか？",
    ] {
        let result = conversation(
            &[
                ("user", "宅配便です"),
                (
                    "assistant",
                    "恐れ入りますが、玄関の前に置いていただけますか。",
                ),
                ("user", confirmation),
            ],
            &normal(),
        );
        assert_eq!(
            reply(&result).as_deref(),
            Some("はい、玄関の前に置いていただければ大丈夫です。")
        );
    }
}

#[test]
fn conversation_closes_after_placement_without_photo() {
    let rules = normal();
    let mut messages: Vec<(&str, String)> = vec![("user", "荷物です".into())];
    let first = VisitState::from_messages(&messages, &rules);
    assert_eq!(
        reply(&first).as_deref(),
        Some("恐れ入りますが、玄関の前に置いていただけますか。")
    );
    messages.push(("assistant", reply(&first).unwrap()));
    messages.push(("user", "そこに置いておきます".into()));
    let second = VisitState::from_messages(&messages, &rules);
    assert_eq!(
        reply(&second).as_deref(),
        Some("はい、玄関の前にお願いいたします。")
    );
    messages.push(("assistant", reply(&second).unwrap()));
    messages.push(("user", "置きました".into()));
    let third = VisitState::from_messages(&messages, &rules);
    assert!(third.placed && !third.photographed);
    assert_eq!(third.fallback(), "失礼いたします。");
    assert_eq!(reply(&third).as_deref(), Some("失礼いたします。"));
    messages.push(("assistant", reply(&third).unwrap()));
    messages.push(("user", "はい、失礼します".into()));
    assert!(VisitState::from_messages(&messages, &rules).should_wait());
}

#[test]
fn delivery_without_known_location_requests_a_slip_and_closes() {
    let mut messages: Vec<(&str, String)> = vec![
        (
            "assistant",
            "いらっしゃいませ。どのようなご用件でしょうか。".into(),
        ),
        ("user", "荷物の配達で来ました".into()),
    ];
    let slip = "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。";
    assert_eq!(
        reply(&VisitState::from_messages(&messages, "")).as_deref(),
        Some(slip)
    );
    messages.push((
        "assistant",
        "お荷物はどちらに置かせていただけますか。".into(),
    ));
    messages.push(("user", "わかりません。それを聞いていますw".into()));
    assert_eq!(
        reply(&VisitState::from_messages(&messages, "")).as_deref(),
        Some(slip)
    );
    messages.push(("assistant", slip.into()));
    messages.push(("user", "わかりました".into()));
    assert_eq!(
        reply(&VisitState::from_messages(&messages, "")).as_deref(),
        Some("ありがとうございます。失礼いたします。")
    );
    let store = conversation(
        &[("user", "荷物の配達で来ました")],
        "配達の荷物は店舗受付カウンターへお持ちください。",
    );
    assert_eq!(reply(&store), None);
}

#[test]
fn circular_board_completion_and_repetition_complaint() {
    let mut messages = vec![
        ("user", "回覧板を回しに来ました"),
        (
            "assistant",
            "回覧板はポストに入れてください。入らない場合はお知らせください。",
        ),
        ("user", "分かりましたじゃあポストに入れておきました"),
    ];
    let completed = conversation(&messages, "");
    assert!(completed.circular_board_placed);
    assert_eq!(
        reply(&completed).as_deref(),
        Some("ありがとうございます。回覧板の件、承知しました。")
    );
    messages.push((
        "assistant",
        "ありがとうございます。回覧板の件、承知しました。",
    ));
    messages.push(("user", "もう入れておきました"));
    let repeated = conversation(&messages, "");
    assert!(repeated.circular_board_acknowledged && repeated.should_wait());
    messages.push((
        "user",
        "ごめんこれ何回も同じこと言ってるんだけどどういうこと?",
    ));
    let complaint = conversation(&messages, "");
    assert!(complaint.repetition_complaint && !complaint.should_wait());
    let expected = "申し訳ありません。回覧板はポストに入れてくださったのですね。同じお願いを繰り返して失礼しました。";
    assert_eq!(reply(&complaint).as_deref(), Some(expected));
    assert!(complaint.validate(expected));

    let other = conversation(
        &[
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "同じことを何度も言ってるんですけど"),
        ],
        &normal(),
    );
    assert_eq!(
        reply(&other).as_deref(),
        Some("申し訳ありません。同じ案内を繰り返してしまいました。先ほどのお話は承知しました。")
    );
}

#[test]
fn instructions_render_python_values() {
    let summary = VisitState::default().instructions();
    assert!(summary.contains("用件=unknown、荷物なしの訂正=False"));
    assert!(summary.contains("保留中の質問=None"));
}
