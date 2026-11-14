import asyncio
from unittest.mock import patch

import pytest
from livekit.agents import llm

from monban_backend.persistence.device_api import ShopProfile
from monban_backend.reception.store_context import normalize_public_context, public_info_reply


def test_shop_profile_maps_to_public_context():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    shop = ShopProfile.from_json({
        "name": "ネイルサロン架空",
        "greeting": "はい、ネイルサロン架空でございます。",
        "business_hours": [
            {"day": 0, "open": "10:00", "close": "19:00", "closed": True},
            {"day": 2, "open": "10:00", "close": "19:00", "closed": False},
            {"day": 3, "open": "11:00", "close": "20:00", "closed": True},
        ],
    })
    tuesday = datetime(2026, 11, 10, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
    assert shop.public_context(tuesday) == {
        "shop_name": "ネイルサロン架空",
        "opening_time": "10:00",
        "closing_time": "19:00",
        "closed_day": "日曜日・水曜日",
    }
    sunday = datetime(2026, 11, 15, 9, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
    assert "opening_time" not in shop.public_context(sunday)
    assert ShopProfile.from_json(None) is None


@pytest.mark.parametrize(
    "values",
    [
        {"private_customer_name": "山田"},
        {"address": None},
        {"closing_time": "x" * 501},
        ["address"],
    ],
)
def test_public_context_rejects_unknown_or_invalid_values(values):
    with pytest.raises(ValueError):
        normalize_public_context(values)


def test_public_info_reply_uses_only_one_explicit_store_setting():
    context = {"opening_time": "10:00", "closing_time": "19:00", "closed_day": "火曜日"}
    assert public_info_reply("営業時間は何時からですか", context) == "開店時刻は10:00です。"
    assert public_info_reply("何時から営業していますか", context) == "開店時刻は10:00です。"
    assert "設定されていない" in public_info_reply("何時から営業ですか", {"closing_time": "19:00"})
    assert public_info_reply("今日は何時まで営業していますか", context) == "閉店時刻は19:00です。"
    assert "設定されていない" in public_info_reply("何時まで営業していますか", {})
    assert public_info_reply("何時から何時まで営業していますか", context) is None
    assert public_info_reply("閉店は何時ですか", context) == "閉店時刻は19:00です。"
    assert public_info_reply("何時に閉まりますか。", context) == "閉店時刻は19:00です。"
    assert public_info_reply("定休日はいつですか", context) == "定休日は火曜日です。"
    assert public_info_reply("お休みの曜日を確認したいです。", context) == "定休日は火曜日です。"
    assert "設定されていない" in public_info_reply("店舗の住所はどこですか", context)
    assert public_info_reply("スタッフに営業時間を確認してください", context) is None
    assert public_info_reply("営業時間と定休日を教えてください", context) is None
    assert public_info_reply("12時の予約です。閉店は何時ですか", context) is None
    assert public_info_reply("こちらは営業していますか", context) == (
        "現在営業中かどうかは、こちらでは確認できません。"
    )


@pytest.mark.parametrize(
    ("question", "public_context", "expected_reply"),
    [
        ("閉店は何時ですか", {"closing_time": "19:00"}, "閉店時刻は19:00です。"),
        ("何時に閉まりますか。", {"closing_time": "19:00"}, "閉店時刻は19:00です。"),
        ("今日は何時まで営業していますか。", {"closing_time": "19:00"}, "閉店時刻は19:00です。"),
        ("何時まで営業していますか。", {"closing_time": "19:00"}, "閉店時刻は19:00です。"),
        (
            "お休みの曜日を確認したいです。",
            {"closed_day": "毎週月曜日"},
            "定休日は毎週月曜日です。",
        ),
        (
            "お休みの曜日を確認したいです。",
            {},
            "その情報はこの店舗に設定されていないため、こちらでは確認できません。",
        ),
        (
            "営業時間は何時からですか",
            {"opening_time": "10:00", "closing_time": "19:00"},
            "開店時刻は10:00です。",
        ),
    ],
)
def test_real_agent_answers_configured_hours_without_model_or_reservation_lookup(
    monkeypatch, question, public_context, expected_reply
):
    from monban_backend.voice import agent as module

    agent = module.ReceptionAgent(public_context=public_context)

    async def scenario():
        context = llm.ChatContext()
        message = context.add_message(role="user", content=question)
        await agent.on_user_turn_completed(context, message)
        with patch.object(
            module.Agent.default,
            "llm_node",
            side_effect=AssertionError("simple public info must be answered deterministically"),
        ), patch.object(
            agent.desk,
            "search_reservations",
            side_effect=AssertionError("public info must not search reservations"),
        ):
            replies = [item async for item in agent.llm_node(context, [], None)]
        assert replies == [expected_reply]

    asyncio.run(scenario())


def test_real_agent_does_not_guess_open_status_or_treat_it_as_sales(monkeypatch):
    from monban_backend.voice import agent as module

    agent = module.ReceptionAgent(public_context={"closing_time": "19:00"})

    async def scenario():
        context = llm.ChatContext()
        message = context.add_message(role="user", content="こちらは営業していますか？")
        await agent.on_user_turn_completed(context, message)
        with patch.object(
            module.Agent.default,
            "llm_node",
            side_effect=AssertionError("open-status questions must not use model inference"),
        ), patch.object(
            agent,
            "request_staff",
            side_effect=AssertionError("open-status questions must not create staff requests"),
        ), patch.object(
            agent.desk,
            "search_reservations",
            side_effect=AssertionError("open-status questions must not search reservations"),
        ):
            replies = [item async for item in agent.llm_node(context, [], None)]
        assert replies == ["現在営業中かどうかは、こちらでは確認できません。"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "utterance",
    [
        "今から予約番号を確認します。",
        "予約の確認メールを探してきますので、少し待ってください。",
    ],
)
def test_real_agent_waits_while_visitor_checks_reservation_details_without_claiming_handoff(
    monkeypatch, utterance
):
    from monban_backend.voice import agent as module

    agent = module.ReceptionAgent()

    async def scenario():
        context = llm.ChatContext()
        message = context.add_message(role="user", content=utterance)
        await agent.on_user_turn_completed(context, message)
        with patch.object(
            module.Agent.default,
            "llm_node",
            side_effect=AssertionError("waiting for visitor input must not invoke the model"),
        ), patch.object(
            agent.desk,
            "search_reservations",
            side_effect=AssertionError("reservation details are not available yet"),
        ):
            replies = [item async for item in agent.llm_node(context, [], None)]
        assert replies == [
            "承知しました。確認できましたら、お知らせください。こちらではお名前と予約時刻で照合します。"
        ]

    asyncio.run(scenario())
