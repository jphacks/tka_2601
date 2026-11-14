import pytest

from monban_backend.reception.business_visits import classify_business_visit
from monban_backend.reception.tool_schema import staff_handoff_required


@pytest.mark.parametrize(
    ("kind", "policy_key", "policy", "expected_reason"),
    [
        ("sales", "sales_policy", "staff_handoff", "営業訪問"),
        ("fee_collection", "fee_collection_policy", "staff_handoff", "集金訪問"),
        ("sales", "sales_policy", "polite_decline", None),
        ("fee_collection", "fee_collection_policy", "polite_decline", None),
    ],
)
def test_reception_agent_hands_business_visits_to_staff_under_store_policy(
    monkeypatch, kind, policy_key, policy, expected_reason
):
    import asyncio
    import json
    from types import SimpleNamespace

    from monban_backend.voice.agent import ReceptionAgent

    settings = {"sales_policy": "polite_decline", "fee_collection_policy": "polite_decline"}
    settings[policy_key] = policy
    agent = ReceptionAgent(business_visit_policies=settings)
    request_reasons = []

    async def request_staff(reason):
        request_reasons.append(reason)
        return json.dumps({"status": "requested"})

    monkeypatch.setattr(agent, "request_staff", request_staff)
    utterance = "この辺りで営業を行なっているものなんですが" if kind == "sales" else "NHKの集金です"
    asyncio.run(agent.on_user_turn_completed(None, SimpleNamespace(text_content=utterance)))

    async def collect():
        return [chunk async for chunk in agent.llm_node(None, [], None)]

    replies = asyncio.run(collect())

    assert request_reasons == ([expected_reason] if expected_reason else [])
    assert replies
    if expected_reason:
        assert "受付一覧" in replies[0]
    elif kind == "fee_collection":
        assert "集金には対応しておりません" in replies[0]
    else:
        assert "営業のご案内をお受けしておりません" in replies[0]


@pytest.mark.parametrize(
    ("kind", "utterance"),
    [
        ("sales", "新サービスの営業で伺いました。"),
        ("fee_collection", "NHKの集金です。"),
    ],
)
def test_business_visit_handoff_failure_is_reported_truthfully(
    monkeypatch, kind, utterance
):
    import asyncio
    import json
    from types import SimpleNamespace

    from monban_backend.voice.agent import ReceptionAgent

    policies = {"sales_policy": "staff_handoff", "fee_collection_policy": "staff_handoff"}
    agent = ReceptionAgent(business_visit_policies=policies)
    request_reasons = []

    async def request_staff(reason):
        request_reasons.append(reason)
        return json.dumps({"status": "error", "code": "invalid_reason"})

    monkeypatch.setattr(agent, "request_staff", request_staff)
    asyncio.run(agent.on_user_turn_completed(None, SimpleNamespace(text_content=utterance)))

    async def collect():
        return [chunk async for chunk in agent.llm_node(None, [], None)]

    replies = asyncio.run(collect())

    assert request_reasons
    assert replies == ["担当者への確認依頼を記録できませんでした。"]
    assert "受付一覧に記録しました" not in replies[0]


@pytest.mark.parametrize("policy", ["staff_handoff", "polite_decline"])
def test_business_visit_followup_does_not_repeat_handling_or_ask_for_reservation_time(
    monkeypatch, policy
):
    import asyncio
    import json

    from livekit.agents import llm
    from monban_backend.voice import agent as module

    policies = {"sales_policy": policy, "fee_collection_policy": "staff_handoff"}
    agent = module.ReceptionAgent(business_visit_policies=policies)
    request_reasons = []

    async def request_staff(reason):
        request_reasons.append(reason)
        return json.dumps({"status": "requested"})

    monkeypatch.setattr(agent, "request_staff", request_staff)

    async def scenario():
        context = llm.ChatContext()
        first = context.add_message(role="user", content="新サービスの営業で伺いました。")
        await agent.on_user_turn_completed(context, first)
        first_reply = [item async for item in agent.llm_node(context, [], None)]
        context.add_message(role="assistant", content="".join(first_reply))

        followup = context.add_message(role="user", content="大場です。")
        await agent.on_user_turn_completed(context, followup)
        followup_reply = [item async for item in agent.llm_node(context, [], None)]

        assert first_reply
        assert followup_reply == ["ありがとうございます。"]
        assert "予約" not in followup_reply[0]
        assert len(request_reasons) == (1 if policy == "staff_handoff" else 0)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("この辺りで営業を行なっているものなんですが", "sales"),
        ("NHKの集金です", "fee_collection"),
        ("営業時間は何時までですか", None),
        ("こちらは営業していますか", None),
        ("今日営業してますか", None),
        ("NHKの集金です\nすみません、集金ではなく宅配便です", None),
        ("営業です\n先ほどの営業ではなく、予約のお客様です", None),
    ],
)
def test_business_visit_classification_respects_corrections(text, expected):
    assert classify_business_visit(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("営業時間は何時までですか", False),
        ("こちらは営業していますか", False),
        ("スタッフに営業時間を確認してください", True),
    ],
)
def test_hours_question_does_not_offer_staff_handoff_unless_requested(text, expected):
    assert staff_handoff_required(text) is expected
