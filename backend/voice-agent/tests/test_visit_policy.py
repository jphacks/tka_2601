import pytest

from monban_backend.voice.visit_policy import VisitState


def state(*turns: str) -> VisitState:
    return VisitState.from_messages([("user", text) for text in turns])


def test_delivery_only_uses_house_rules_for_confirmed_parcel():
    assert state("宅配便です").delivery_allowed
    assert not state("NHKの集金です").delivery_allowed
    assert not state("営業で来ました").delivery_allowed


def test_payment_and_sales_reject_inappropriate_reply():
    assert state("集金に来ました").purpose == "payment"
    assert not state("集金に来ました").validate("宅配ボックスに入れてください。")
    assert state("営業で来ました").fallback().startswith("申し訳ありません")


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
    result = state("宅配便です", "そこに置きました", "写真も撮りました。これで大丈夫ですか?")
    assert result.placed and result.photographed
    assert result.validate("ありがとうございます。")
    assert not result.validate("解錠しました。")


def test_completion_state_still_answers_a_follow_up_question():
    # A question after the completed delivery remains answerable instead of receiving an early goodbye.
    result = state("宅配便です", "そこに置きました", "写真も撮りました。これで大丈夫ですか?")
    assert result.validate("はい、大丈夫です。")
    assert not result.validate("玄関の鍵を開けます。")


def test_farewell_is_not_repeated_after_it_was_said():
    # Regression: the visitor's "はい失礼します" made the agent say "失礼します。" again and again.
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "承知いたしました。失礼いたします。"),
            ("user", "はい失礼します"),
        ]
    )
    assert result.closing and result.closing_said
    assert result.should_wait


def test_new_request_after_farewell_is_still_answered():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "承知いたしました。失礼いたします。"),
            ("user", "すみません、クール便でした"),
        ]
    )
    assert result.closing_said
    assert not result.should_wait


def test_delivery_announcement_and_placement_question_get_direct_replies():
    turns = [
        ("user", "こんにちは"),
        ("assistant", "どちらの用件でいらっしゃいましたか。"),
        ("user", "宅配できました"),
        ("assistant", "玄関の前に置いていただけますか。"),
        ("user", "じゃあ置いていきますね"),
    ]
    placing = VisitState.from_messages(turns)
    assert placing.delivery_allowed
    assert placing.visitor_will_place
    assert not placing.placed
    assert placing.deterministic_reply == "はい、玄関の前にお願いいたします。"

    turns.append(("assistant", placing.deterministic_reply))
    turns.append(("user", "どうやっていけば大丈夫ですか?"))
    question = VisitState.from_messages(turns)
    assert question.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"
    assert question.validate(question.deterministic_reply)

    turns.append(("assistant", "失礼いたします。"))
    turns.append(("user", "失礼しますというかどうすればいいですか"))
    follow_up = VisitState.from_messages(turns)
    assert not follow_up.closing
    assert follow_up.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"


def test_recognizes_asr_variant_of_delivery_announcement_and_confirmation():
    announced = state("宅配できました")
    assert announced.delivery_allowed
    assert announced.deterministic_reply == "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。"
    confirmed = VisitState.from_messages(
        [("user", "宅配便です"), ("assistant", "玄関前にお願いします"), ("user", "置いておいてば大丈夫ですか")]
    )
    assert confirmed.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"

    acknowledgement = VisitState.from_messages(
        [
            ("user", "宅配できました"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "ありがとうございました"),
        ]
    )
    # Standalone past-tense thanks requests departure; present-tense thanks stays open.
    assert acknowledgement.closing
    assert acknowledgement.deterministic_reply == "失礼いたします。"


def test_deterministic_placement_reply_uses_the_location_already_requested():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "宅配ボックスに入れていただけますか"),
            ("user", "ここに入れて大丈夫ですか"),
        ]
    )
    assert result.deterministic_reply == "はい、宅配ボックスに入れていただければ大丈夫です。"


def test_placement_intention_is_not_mistaken_for_completion_or_farewell():
    result = state("宅配便です", "玄関の前に置いていただけますか", "じゃあ置いていきますね")
    assert result.visitor_will_place
    assert not result.placed
    assert not result.closing
    assert not result.validate("失礼いたします。")


def test_farewell_must_be_the_end_of_reply():
    result = state("失礼します")
    assert not result.validate("承知しました。失礼いたします。ほかに何かありますか？")
    assert result.fallback() == "失礼いたします。"

    completed = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか"),
            ("user", "置きました"),
            ("assistant", "写真もお願いします"),
            ("user", "写真も撮りました"),
        ]
    )
    generated = "失礼いたします。ほかに何かありますか？"
    clipped = completed.trim_after_farewell(generated)
    assert clipped == "失礼いたします。"
    assert completed.validate(clipped)


def test_payment_refusal_does_not_carry_over_to_circular_board():
    result = VisitState.from_messages(
        [
            ("user", "NHKの集金なんですけど"),
            ("assistant", "このインターホンではお支払いに対応できません。"),
            ("user", "すいません、回覧版なんですけど"),
            ("assistant", "回覧板はポストに入れてください。"),
            ("user", "回覧板はどこに置けばいいですか?"),
        ]
    )
    assert result.purpose == "circular_board"
    assert result.deterministic_reply == "回覧板はポストに入れてください。入らない場合はお知らせください。"
    assert result.validate(result.deterministic_reply)
    assert "お支払い" not in result.fallback()


def test_name_confirmation_after_reflection_is_not_unsupported_purpose():
    result = VisitState.from_messages(
        [
            ("assistant", "大葉様ですね。どのようなご用件でしょうか。"),
            ("user", "はい大場です"),
        ]
    )
    assert result.name_confirmation
    assert result.deterministic_reply == "失礼しました。お名前の確認ありがとうございます。"
    assert result.validate(result.deterministic_reply)


def test_explicit_name_correction_after_reflection_is_acknowledged():
    result = VisitState.from_messages(
        [
            ("assistant", "大葉様ですね。どのようなご用件でしょうか。"),
            ("user", "大葉じゃなくて大場です"),
        ]
    )
    assert result.name_confirmation
    assert result.deterministic_reply == "失礼しました。お名前の確認ありがとうございます。"


def test_presence_question_does_not_disclose_resident_status():
    result = state("今いらっしゃいますか")
    assert result.presence_question
    assert result.deterministic_reply == "住人の在宅状況はお伝えできません。ご用件をお聞かせください。"
    assert result.validate(result.deterministic_reply)
    assert not result.validate("はい、在宅しています。")


def test_unknown_follow_up_does_not_get_generic_intercom_refusal():
    result = VisitState.from_messages(
        [
            ("assistant", "どのようなご用件でしょうか。"),
            ("user", "ちょっと聞きたいことがあるんですけど"),
        ]
    )
    assert result.fallback() == "恐れ入りますが、もう少し詳しくお聞かせください。"
    assert "対応できません" not in result.fallback()


def test_circular_board_that_does_not_fit_prompts_for_placement():
    result = VisitState.from_messages(
        [("user", "回覧板です"), ("assistant", "回覧板はポストに入れてください。"), ("user", "ポストに入らないです")]
    )
    assert result.deterministic_reply == "ポストに入らない場合は、どちらに置けばよろしいでしょうか。"


def test_circular_board_respects_an_explicit_resident_rule():
    result = VisitState.from_messages(
        [("user", "回覧板はどこに置けばいいですか?")],
        "回覧板は玄関前に置いてください。",
    )
    assert result.deterministic_reply is None
    assert result.validate("回覧板は玄関前に置いてください。")


def test_photo_how_to_follow_up_gets_answer_even_after_farewell():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "置きました"),
            ("assistant", "荷物と置き場所の写真を撮ってください。"),
            ("user", "写真撮りました"),
            ("assistant", "失礼いたします。"),
            ("user", "撮った写真はどうしたらいいですか"),
        ]
    )
    assert result.deterministic_reply == "こちらへの写真の撮影や送付は不要です。配達会社の手順に従ってください。"
    assert result.validate(result.deterministic_reply)


def test_placement_question_does_not_mark_delivery_as_placed():
    result = VisitState.from_messages([("user", "配達です"), ("user", "どこに置いたらいいですか？")], "玄関の前に置いてください")
    assert not result.placed


@pytest.mark.parametrize("reply", ["荷物と置き場所の写真を撮ってください。", "写真を送ってください。", "写真を保管してください。", "撮影してください。"])
def test_photo_requests_are_rejected(reply):
    result = VisitState.from_messages([("user", "配達です"), ("user", "置きました")])
    assert not result.validate(reply)
