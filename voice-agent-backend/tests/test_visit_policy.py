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
    assert result.fallback() == "お気をつけてお帰りください。"


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
