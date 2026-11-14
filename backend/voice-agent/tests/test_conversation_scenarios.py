import pytest
from livekit.agents.llm import ChatContext

from monban_backend.agent import _context_with_state_instructions
from monban_backend.core.house_rules import base_rules
from monban_backend.voice.visit_policy import VisitState


@pytest.mark.parametrize("announcement", ["宅配便です", "荷物です", "ヤマト運輸です", "佐川急便です"])
def test_common_delivery_announcements_get_a_house_rule_reply(announcement):
    state = VisitState.from_messages(
        [("assistant", "はい、どちら様でしょうか。"), ("user", announcement)],
        base_rules("normal"),
    )

    assert state.purpose == "delivery"
    assert state.deterministic_reply == "恐れ入りますが、玄関の前に置いていただけますか。"
    assert state.validate(state.deterministic_reply)


@pytest.mark.parametrize("correction", ["営業じゃなくて宅配便です", "集金ではなく宅配便です"])
def test_explicit_purpose_corrections_select_the_corrected_topic(correction):
    state = VisitState.from_messages([("user", correction)], base_rules("normal"))

    assert state.purpose == "delivery"
    assert state.deterministic_reply == "恐れ入りますが、玄関の前に置いていただけますか。"


def test_multi_turn_payment_to_delivery_correction_does_not_repeat_the_refusal():
    state = VisitState.from_messages(
        [
            ("user", "NHKの集金です"),
            ("assistant", "このインターホンではお支払いに対応できません。"),
            ("user", "すみません、集金ではなく宅配便です"),
        ],
        base_rules("normal"),
    )

    assert state.purpose == "delivery"
    assert "玄関の前" in state.deterministic_reply
    assert "お支払い" not in state.deterministic_reply


def test_full_delivery_box_switches_to_the_configured_alternate_location():
    rules = "宅配ボックスを優先し、入らない場合は玄関前に置いてください。"
    state = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "恐れ入りますが、宅配ボックスに入れていただけますか。"),
            ("user", "宅配ボックスがいっぱいでした"),
        ],
        rules,
    )

    assert state.requested_delivery_location == "玄関の前"
    assert state.deterministic_reply == "宅配ボックスに入らない場合は、玄関の前に置いていただけますか。"


def test_away_mode_without_a_drop_location_requests_a_delivery_slip():
    state = VisitState.from_messages([("user", "宅配便です")], base_rules("away"))

    assert state.deterministic_reply == "恐れ入りますが、不在票を入れていただけますか。"


@pytest.mark.parametrize("utterance", ["クール便です", "宅配便ですが代引きです"])
def test_delivery_types_that_cannot_be_left_request_a_delivery_slip(utterance):
    state = VisitState.from_messages([("user", utterance)], base_rules("normal"))

    assert state.delivery_allowed
    assert state.delivery_unavailable
    assert state.deterministic_reply == "恐れ入りますが、不在票を入れていただけますか。"


@pytest.mark.parametrize(
    "confirmation",
    ["玄関前でいいですか？", "玄関の前で大丈夫ですか？", "ここに置いて大丈夫ですか？"],
)
def test_natural_placement_confirmations_get_a_direct_yes(confirmation):
    state = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "恐れ入りますが、玄関の前に置いていただけますか。"),
            ("user", confirmation),
        ],
        base_rules("normal"),
    )

    assert state.deterministic_reply == "はい、玄関の前に置いていただければ大丈夫です。"


def test_conversation_closes_after_placement_without_photo():
    rules = base_rules("normal")
    messages = [("user", "荷物です")]

    state = VisitState.from_messages(messages, rules)
    assert state.deterministic_reply == "恐れ入りますが、玄関の前に置いていただけますか。"

    messages.extend(
        [
            ("assistant", state.deterministic_reply),
            ("user", "そこに置いておきます"),
        ]
    )
    state = VisitState.from_messages(messages, rules)
    assert state.deterministic_reply == "はい、玄関の前にお願いいたします。"

    messages.extend([("assistant", state.deterministic_reply), ("user", "置きました")])
    state = VisitState.from_messages(messages, rules)
    assert state.placed and not state.photographed
    assert state.fallback() == "失礼いたします。"
    assert state.deterministic_reply == "失礼いたします。"

    messages.extend([("assistant", state.deterministic_reply), ("user", "はい、失礼します")])
    state = VisitState.from_messages(messages, rules)
    assert state.should_wait


def test_delivery_without_known_location_does_not_ask_the_courier_where_to_put_it():
    messages = [
        ("assistant", "いらっしゃいませ。どのようなご用件でしょうか。"),
        ("user", "荷物の配達で来ました"),
    ]
    state = VisitState.from_messages(messages, "")
    assert state.deterministic_reply == "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。"

    messages.extend([("assistant", "お荷物はどちらに置かせていただけますか。"), ("user", "わかりません。それを聞いていますw")])
    state = VisitState.from_messages(messages, "")
    assert state.deterministic_reply == "恐れ入りますが、置き場所を指定できないため、不在票をお願いいたします。"

    messages.extend([("assistant", state.deterministic_reply), ("user", "わかりました")])
    state = VisitState.from_messages(messages, "")
    assert state.deterministic_reply == "ありがとうございます。失礼いたします。"


def test_specific_store_delivery_instruction_can_be_used_by_the_model():
    state = VisitState.from_messages([("user", "荷物の配達で来ました")], "配達の荷物は店舗受付カウンターへお持ちください。")
    assert state.deterministic_reply is None


def test_circular_board_completion_is_acknowledged_instead_of_repeating_the_instruction():
    rules = ""
    messages = [
        ("user", "回覧板を回しに来ました"),
        ("assistant", "回覧板はポストに入れてください。入らない場合はお知らせください。"),
        ("user", "分かりましたじゃあポストに入れておきました"),
    ]

    completed = VisitState.from_messages(messages, rules)

    assert completed.circular_board_placed
    assert completed.deterministic_reply == "ありがとうございます。回覧板の件、承知しました。"
    assert completed.deterministic_reply != messages[1][1]

    messages.extend(
        [
            ("assistant", completed.deterministic_reply),
            ("user", "もう入れておきました"),
        ]
    )
    repeated_completion = VisitState.from_messages(messages, rules)
    assert repeated_completion.circular_board_placed
    assert repeated_completion.circular_board_acknowledged
    assert repeated_completion.should_wait


def test_repetition_complaint_gets_an_apology_and_acknowledges_the_completed_task():
    state = VisitState.from_messages(
        [
            ("user", "回覧板を回しに来ました"),
            ("assistant", "回覧板はポストに入れてください。入らない場合はお知らせください。"),
            ("user", "分かりましたじゃあポストに入れておきました"),
            ("assistant", "ありがとうございます。回覧板の件、承知しました。"),
            ("user", "もう入れておきました"),
            ("user", "ごめんこれ何回も同じこと言ってるんだけどどういうこと?"),
        ]
    )

    assert state.repetition_complaint
    assert not state.should_wait
    assert state.deterministic_reply == (
        "申し訳ありません。回覧板はポストに入れてくださったのですね。"
        "同じお願いを繰り返して失礼しました。"
    )
    assert state.validate(state.deterministic_reply)


def test_repetition_complaint_is_handled_for_other_purposes_too():
    state = VisitState.from_messages(
        [
            ("user", "宅配便です"),
            ("assistant", "玄関の前に置いていただけますか。"),
            ("user", "同じことを何度も言ってるんですけど"),
        ],
        base_rules("normal"),
    )

    assert state.deterministic_reply == (
        "申し訳ありません。同じ案内を繰り返してしまいました。先ほどのお話は承知しました。"
    )
    assert state.validate(state.deterministic_reply)


def test_state_guidance_is_kept_with_the_system_prompt_before_dialogue():
    context = ChatContext()
    context.add_message(role="system", content="常に守る指示")
    context.add_message(role="user", content="宅配便です")

    prepared = _context_with_state_instructions(context, "このターンの状態")

    assert [(item.role, item.text_content) for item in prepared.messages()] == [
        ("system", "常に守る指示"),
        ("system", "このターンの状態"),
        ("user", "宅配便です"),
    ]
    assert [(item.role, item.text_content) for item in context.messages()] == [
        ("system", "常に守る指示"),
        ("user", "宅配便です"),
    ]
    formatted, _ = prepared.to_provider_format("openai")
    assert formatted == [
        {"role": "system", "content": "常に守る指示\nこのターンの状態"},
        {"role": "user", "content": "宅配便です"},
    ]
