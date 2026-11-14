import asyncio
from unittest.mock import patch

from livekit.agents import llm

from monban_backend.reception import prefetch
from monban_backend.reception.business_visits import DEFAULT_BUSINESS_VISIT_POLICIES
from monban_backend.voice import agent as module


def make_agent(monkeypatch):
    return module.ReceptionAgent(business_visit_policies=dict(DEFAULT_BUSINESS_VISIT_POLICIES))


def message(role, text):
    return llm.ChatMessage(role=role, content=[text])


def test_explicit_appointment_time_is_separate_from_arrival_time():
    assert prefetch.extract_explicit_appointment_time(
        "佐藤花子です。予約は15時で、到着したのは14:55です。"
    ) == "15:00"
    assert prefetch.extract_explicit_appointment_time(
        "娘の予約は16時、私は15時です。"
    ) is None
    assert prefetch.extract_explicit_appointment_time(
        "予約は15時です。その後、予約時刻は16時に訂正します。"
    ) == "16:00"
    assert prefetch.extract_explicit_appointment_time(
        "予約は15時です。時間は16時に変更です。"
    ) is None


def test_repeats_prior_wait_location_without_staff_or_model(monkeypatch):
    agent = make_agent(monkeypatch)
    assistant = message("assistant", "入口のソファでお待ちください。")
    user = message("user", "どこで待つんでしたっけ？")
    context = llm.ChatContext(items=[assistant, user])
    asyncio.run(agent.on_user_turn_completed(context, user))

    async def collect():
        with patch.object(
            module.Agent.default,
            "llm_node",
            side_effect=AssertionError("known location should bypass the model"),
        ), patch.object(
            agent,
            "request_staff",
            side_effect=AssertionError("known location must not be handed off"),
        ):
            return [item async for item in agent.llm_node(context, [], None)]

    assert asyncio.run(collect()) == ["入口のソファでお待ちください。"]


def test_reservation_time_question_matcher_does_not_capture_business_hours():
    assert module._RESERVATION_TIME_QUESTION.search("予約は何時でしたか")
    assert module._RESERVATION_TIME_QUESTION.search("予約時間を教えてください")
    assert not module._RESERVATION_TIME_QUESTION.search("何時まで予約できますか")


def test_repeats_stated_reservation_time_without_claiming_verification(monkeypatch):
    agent = make_agent(monkeypatch)
    first = message("user", "佐藤花子です。予約は15時で、到着したのは14:55です。")
    first_context = llm.ChatContext(items=[first])
    asyncio.run(agent.on_user_turn_completed(first_context, first))
    assistant = message("assistant", "15時のご予約で、14:55に到着されたのですね。")
    latest = message("user", "予約は何時でしたか？")
    context = llm.ChatContext(items=[first, assistant, latest])
    asyncio.run(agent.on_user_turn_completed(context, latest))

    async def collect():
        with patch.object(
            module.Agent.default,
            "llm_node",
            side_effect=AssertionError("explicit historical time should be retrieved"),
        ):
            return [item async for item in agent.llm_node(context, [], None)]

    assert asyncio.run(collect()) == ["先ほどは15時のご予約と伺っています。"]
