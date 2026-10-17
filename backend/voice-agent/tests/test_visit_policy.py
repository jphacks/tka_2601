from door_backend.visit_policy import VisitState


def state(*turns: str) -> VisitState:
    return VisitState.from_messages([("user", text) for text in turns])


def test_delivery_only_uses_house_rules_for_confirmed_parcel():
    assert state("宅配便です").delivery_allowed
    assert not state("NHKの集金です").delivery_allowed
    assert not state("営業で来ました").delivery_allowed


def test_payment_and_sales_reject_inappropriate_reply():
    assert state("集金に来ました").purpose == "payment"
    assert not state("集金に来ました").validate("宅配ボックスに入れてください。")
    assert state("営業で来ました").fallback() == "恐れ入りますが、このインターホンでは対応できません。"


def test_company_introduction_is_not_sales_until_the_offer_is_clear():
    introduction = state("お世話になっております私株式会社ライフエーステックの大坂敏と申します")
    assert introduction.purpose == "unknown"

    offer = state(
        "我々の企業では中高生向けのプログラミング教育を行っているんですけれども、"
        "こちらのお宅のお子様にも教育を受けていただきたいと思いまして"
    )
    assert offer.purpose == "sales"
    assert offer.fallback() == "恐れ入りますが、このインターホンでは対応できません。"


def test_polite_farewell_is_acknowledged_as_departure():
    result = state("承知いたしました。また改めて伺わせていただきます。失礼いたします")
    assert result.closing
    assert result.fallback() == "承知いたしました。失礼いたします。"


def test_correction_overrides_delivery_context():
    result = VisitState.from_messages(
        [("user", "宅配便です"), ("assistant", "宅配ボックスへお願いします"), ("user", "荷物ではありません")]
    )
    assert result.no_parcel
    assert not result.delivery_allowed
    assert not result.validate("荷物と置き場所の写真を撮ってください。")


def test_filler_and_incomplete_phrase_wait_for_more_audio():
    assert state("えっと").should_wait
    assert state("それが終わったら").should_wait
    assert not state("宅配便です").should_wait


def test_completion_state_is_session_scoped_and_validated():
    result = state("宅配便です", "そこに置きました", "写真も撮りました")
    assert result.placed and result.photographed
    assert result.validate("ありがとうございます。")
    assert not result.validate("解錠しました。")


def test_completion_state_answers_follow_up_instead_of_forcing_thanks():
    result = state("宅配便です", "そこに置きました", "写真も撮りました")
    assert result.validate("はい、大丈夫ですよ。")
    assert not result.validate("鍵を開けました。")


def test_goodbye_is_not_repeated_after_a_closing_acknowledgement():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "承知いたしました。失礼いたします。"),
            ("user", "はい失礼します"),
        ]
    )
    assert result.closing_said
    assert result.should_wait


def test_arrival_politeness_is_not_misread_as_departure():
    result = state("夜分に失礼いたします。宅配便です")
    assert result.delivery_allowed
    assert not result.closing


def test_delivery_placement_turns_answer_directly_and_do_not_end_early():
    turns = [
        ("user", "こんにちは"),
        ("assistant", "どちらの用件でいらっしゃいましたか。"),
        ("user", "宅配できました"),
        ("assistant", "玄関の前に置いていただけますか。"),
        ("user", "じゃあ置いていきますね"),
    ]
    placing = VisitState.from_messages(turns)
    assert placing.delivery_allowed and placing.visitor_will_place
    assert not placing.placed
    assert placing.deterministic_reply == "はい、玄関の前にお願いいたします。"

    turns.extend([("assistant", placing.deterministic_reply), ("user", "どうやっていけば大丈夫ですか?")])
    question = VisitState.from_messages(turns)
    assert question.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"
    assert question.validate(question.deterministic_reply)

    turns.extend([("assistant", "失礼いたします。"), ("user", "失礼しますというかどうすればいいですか")])
    follow_up = VisitState.from_messages(turns)
    assert not follow_up.closing
    assert follow_up.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"


def test_placement_confirmation_and_acknowledgement_are_not_repeated():
    confirmed = VisitState.from_messages(
        [("user", "宅配便です"), ("assistant", "玄関前にお願いします"), ("user", "置いておいてば大丈夫ですか")]
    )
    assert confirmed.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"

    acknowledgement = VisitState.from_messages(
        [("user", "宅配できました"), ("assistant", "玄関の前に置いていただけますか。"), ("user", "ありがとうございました")]
    )
    assert acknowledgement.deterministic_reply == "はい、よろしくお願いいたします。"


def test_farewell_must_end_reply_and_is_only_allowed_when_done():
    pending = VisitState.from_messages(
        [("user", "宅配便です"), ("assistant", "玄関の前に置いていただけますか。"), ("user", "置きました")]
    )
    assert not pending.validate("失礼いたします。")

    done = VisitState.from_messages(
        [("user", "失礼します")]
    )
    assert not done.validate("承知しました。失礼いたします。ほかに何かありますか？")
    assert done.trim_after_farewell("承知しました。失礼いたします。ほかに何かありますか？") == "承知しました。失礼いたします。"
