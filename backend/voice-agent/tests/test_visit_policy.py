from door_backend.visit_policy import VisitState


def test_completed_dropoff_phrasings_advance_instead_of_repeating_location():
    for text in [
        "じゃあ置いておきました", "荷物を置いてきましたよ", "玄関の前に置いたよ",
        "荷物は置いてあります", "置かせていただきました", "置き終えました",
        "宅配ボックスに入れておきました", "荷物を入れたよ",
    ]:
        result = VisitState.from_messages([
            ("user", "宅配便です。荷物を届けに来ました。"),
            ("assistant", "玄関の前に置いていただけますか。"), ("user", text),
        ])
        assert result.placed, text
        assert "写真" in result.deterministic_reply, text
        assert "置いていただけ" not in result.deterministic_reply, text
        assert not result.validate("恐れ入りますが、ご用件をお聞かせください。"), text


def test_future_negative_questions_and_corrections_do_not_claim_completion():
    for text in [
        "これから置いておきます", "置いてきます", "まだ置いていません", "まだ置いてないです",
        "置いてません", "置けません", "入れていません", "置いたらいいですか",
        "置いておきましたか", "置いたことにしてください", "置きましたが、まだ置いていません",
    ]:
        result = VisitState.from_messages([
            ("user", "宅配便です"), ("assistant", "玄関の前にお願いします"), ("user", text),
        ])
        assert not result.placed, text
    correction = VisitState.from_messages([
        ("user", "宅配便です"), ("user", "置いておきました"), ("user", "訂正です、まだ置いていません"),
    ])
    assert not correction.placed
    assert state("宅配便です", "まだ置いていません。あ、今置いてきました").placed


def test_possible_asr_error_requires_confirmation_then_progresses():
    for text in ["玄関の前に荷物を売ってきましたよ", "玄関の前に通っておきました"]:
        turns = [("user", "宅配便です"), ("assistant", "玄関前にお願いします"), ("user", text)]
        uncertain = VisitState.from_messages(turns)
        assert not uncertain.placed
        assert "置き終わった" in uncertain.deterministic_reply
        confirmed = VisitState.from_messages(turns + [("assistant", uncertain.deterministic_reply), ("user", "はいそうです")])
        assert confirmed.placed
        assert "写真" in confirmed.deterministic_reply
        denied = VisitState.from_messages(turns + [("assistant", uncertain.deterministic_reply), ("user", "いいえ")])
        assert not denied.placed


def test_actual_delivery_sequence_moves_from_dropoff_to_photo_to_farewell():
    turns = [("user", "宅配便です"), ("assistant", "玄関前にお願いします"), ("user", "じゃあ置いておきました")]
    placed = VisitState.from_messages(turns)
    turns += [("assistant", placed.deterministic_reply), ("user", "写真も撮りました")]
    finished = VisitState.from_messages(turns)
    assert finished.placed and finished.photographed
    assert finished.deterministic_reply == "失礼いたします。"
    assert finished.should_end_after_reply(finished.deterministic_reply)


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
    assert result.fallback() == "失礼いたします。"


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


def test_completion_state_answers_follow_up_instead_of_forcing_thanks():
    result = state("宅配便です", "そこに置きました", "写真も撮りました。これで大丈夫ですか?")
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
    assert not done.validate("失礼いたします。ほかに何かありますか？")
    assert done.trim_after_farewell("失礼いたします。ほかに何かありますか？") == "失礼いたします。"


def test_asr_placement_homophone_is_corrected_in_delivery_context():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "はい、起きました"),
        ]
    )
    assert result.placed
    assert result.fallback() == "恐れ入りますが、荷物と置き場所の写真を撮ってください。"


def test_photo_follow_up_after_completion_is_answered_without_farewell():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "玄関の前にお願いします"),
            ("user", "そこに置きました"),
            ("assistant", "荷物と置き場所の写真を撮ってください"),
            ("user", "写真撮りました"),
            ("assistant", "失礼いたします。"),
            ("user", "写真はどうしたらいいの"),
        ]
    )
    assert result.deterministic_reply == "写真はこのインターホンには送れないため、お手元に保管してください。ありがとうございます。"

    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "写真を撮ってください"),
            ("user", "写真撮りました"),
            ("user", "保管すればいいの?"),
        ]
    )
    assert result.deterministic_reply == "はい、そのままお手元で保管していただければ大丈夫です。"


def test_delivery_box_question_follows_house_rules_and_does_not_echo_asr_error():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "玄関の前にお願いします"),
            ("user", "この荷物大きいので高いボックスを使ってもいいですか"),
        ],
        "宅配ボックスを優先し、入らない場合は玄関前に置いてください。",
    )
    assert result.deterministic_reply == "宅配ボックスに入る大きさでしたら、そちらをご利用ください。入らない場合は玄関前にお願いします。"


def test_ambiguous_completion_after_agreed_dropoff_moves_to_photo_step():
    turns = [
        ("user", "荷物の配達に行きました"),
        ("assistant", "玄関の前に置いていただけますか。"),
        ("user", "分かりました置いておきますね"),
    ]
    turns.append(("assistant", "はい、玄関の前にお願いいたします。"))
    turns.append(("user", "来ました荷物を"))
    result = VisitState.from_messages(turns)
    assert result.placed
    assert result.deterministic_reply == "恐れ入りますが、荷物と置き場所の写真を撮ってください。"


def test_corrected_ack_after_goodbye_does_not_restart_conversation():
    result = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "失礼いたします。"),
            ("user", "おかえりましたじゃなくて分かりました"),
        ]
    )
    assert result.should_wait


def test_payment_refusal_does_not_carry_over_to_circular_board():
    result = VisitState.from_messages(
        [
            ("user", "NHKの集金なんですけど"),
            ("assistant", "このインターホンではお支払いに対応できません。"),
            ("user", "すいません、回覧版なんですけど"),
            ("assistant", "回覧板はポストにお願いします。"),
            ("user", "回覧板はどこに置けばいいですか?"),
        ]
    )
    assert result.purpose == "circular_board"
    assert result.deterministic_reply == "回覧板はポストに入れてください。入らない場合はお知らせください。"
    assert result.validate(result.deterministic_reply)
    assert "お支払い" not in result.fallback()


def test_name_confirmation_after_reflection_does_not_restart_purpose_rejection():
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


def test_presence_question_never_discloses_resident_status():
    result = state("今いらっしゃいますか")
    assert result.deterministic_reply == "住人の在宅状況はお伝えできません。ご用件をお聞かせください。"
    assert result.validate(result.deterministic_reply)
    assert not result.validate("はい、在宅しています。")


def test_unclear_follow_up_after_purpose_prompt_does_not_become_unsupported_refusal():
    result = VisitState.from_messages(
        [
            ("assistant", "どのようなご用件でしょうか。"),
            ("user", "ちょっと聞きたいことがあるんですけど"),
        ]
    )
    assert result.fallback() == "承知しました。"
    assert "対応できません" not in result.fallback()


def test_circular_board_that_does_not_fit_prompts_for_placement():
    result = VisitState.from_messages(
        [("user", "回覧板です"), ("assistant", "回覧板はポストにお願いします。"), ("user", "ポストに入らないです")]
    )
    assert result.deterministic_reply == "ポストに入らない場合は、どちらに置けばよろしいでしょうか。"


def test_circular_board_respects_an_explicit_resident_rule():
    result = VisitState.from_messages(
        [("user", "回覧板はどこに置けばいいですか?")],
        "回覧板は玄関前に置いてください。",
    )
    assert result.deterministic_reply is None
    assert result.validate("回覧板は玄関前に置いてください。")


def test_device_hangup_uses_validated_final_reply_not_delivery_progress():
    messages = [
        ('user', '宅配便です。'),
        ('assistant', '玄関前にお願いします。荷物と置き場所の写真を撮ってください。'),
        ('user', '荷物を置きました。写真も撮りました。'),
    ]
    state = VisitState.from_messages(messages, '玄関前に置いて写真を撮ってください。')
    assert state.should_end_after_reply('失礼いたします。')
    assert not state.should_end_after_reply('失礼いたします。別の質問ですが。')
    follow_up = VisitState.from_messages(messages + [('user', '写真はどこに送ればいいですか。')], state.house_rules)
    assert not follow_up.should_end_after_reply(follow_up.deterministic_reply or follow_up.fallback())


def test_device_sales_and_payment_close_after_policy_valid_refusal():
    for text in ('プログラミング教室の無料体験のご案内です。', '集金に来ました。'):
        state = VisitState.from_messages([('user', text)], '')
        assert state.should_end_after_reply(state.deterministic_reply or state.fallback())
        assert not state.should_end_after_reply('荷物を玄関に置いてください。')
