import asyncio
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from monban_backend.persistence import device_api
from monban_backend.reception import service
from monban_backend.reception.matching import Reservation
from monban_backend.reception.tool_schema_v17 import TOOL_SCHEMAS_V17
from monban_backend.voice.agent import ReceptionAgent


DEVICE_KEY = "test-device-key"
TZ = ZoneInfo("Asia/Tokyo")


class FakeSupabase:
    """In-memory stand-in for the Supabase device API's reservations."""

    def __init__(self):
        self.reservations: list[device_api.RemoteReservation] = []
        self.fail = False
        self.list_calls = 0
        self.arrived: list[str] = []

    def add(self, reservation_id, name, start):
        self.reservations.append(device_api.RemoteReservation(
            id=reservation_id, customer_name=name, service_name=None,
            starts_at=start, ends_at=start + timedelta(hours=1), status="confirmed", arrived_at=None,
        ))

    async def list_reservations(self, device_key, start, end):
        assert device_key == DEVICE_KEY
        self.list_calls += 1
        if self.fail:
            raise device_api.DeviceApiError(None, "offline")
        return list(self.reservations)

    async def arrive(self, device_key, reservation_id):
        assert device_key == DEVICE_KEY
        self.arrived.append(reservation_id)
        for index, item in enumerate(self.reservations):
            if item.id == reservation_id:
                self.reservations[index] = device_api.RemoteReservation(
                    **{**item.__dict__, "arrived_at": "2026-11-14T05:00:00.000Z"}
                )
                return self.reservations[index]
        raise device_api.DeviceApiError(404)


@pytest.fixture
def supabase(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(device_api, "list_reservations", fake.list_reservations)
    monkeypatch.setattr(device_api, "arrive", fake.arrive)
    return fake


def desk():
    return service.ReceptionDesk(DEVICE_KEY)


def two_pm():
    return datetime.now(TZ).replace(hour=14, minute=0, second=0, microsecond=0)


def test_reception_agent_exposes_the_canonical_tool_schemas():
    exposed = {
        tool.info.raw_schema["name"]: tool.info.raw_schema
        for tool in ReceptionAgent().tools
    }
    assert exposed == TOOL_SCHEMAS_V17


def test_reception_agent_records_arrival_and_handles_failure(supabase):
    supabase.add("reservation-1", "山田太郎", two_pm())
    agent = ReceptionAgent(desk())
    result = asyncio.run(agent.check_reservation(name="山田太郎", hour=14, minute=0))
    assert "予約を確認" in result
    asyncio.run(agent.check_reservation(name="山田太郎", hour=14, minute=0))
    assert supabase.arrived == ["reservation-1"]  # the second call sees arrived_at

    supabase.fail = True
    agent.desk.invalidate()
    assert "スタッフ" in asyncio.run(agent.check_reservation(name="山田太郎", hour=14, minute=0))
    assert agent.desk.staff_requests == ["山田太郎"]


def test_reception_agent_separates_search_checkin_and_staff_notification(supabase):
    import json
    from types import SimpleNamespace

    supabase.add("reservation-split", "山田太郎", two_pm())
    agent = ReceptionAgent(desk())
    asyncio.run(
        agent.on_user_turn_completed(
            None, SimpleNamespace(text_content="14:00の予約で山田太郎です。来店受付をお願いします。")
        )
    )

    found = json.loads(asyncio.run(agent.search_reservations("山田太郎", "14:00")))
    assert found["status"] == "matched"
    assert found["reservation_id"] == "reservation-split"
    assert supabase.arrived == []  # search is read-only

    checked_in = json.loads(asyncio.run(agent.check_in("reservation-split")))
    assert checked_in["status"] == "checked_in"
    assert supabase.arrived == ["reservation-split"]

    notification = json.loads(asyncio.run(agent.notify_staff("reservation-split", "予約客の来店")))
    assert notification == {"status": "recorded", "channel": "staff_reception_list"}

    duplicate = json.loads(asyncio.run(agent.notify_staff("reservation-split", "予約客の来店")))
    assert duplicate["status"] == "already_recorded"


def test_reception_agent_rejects_a_name_not_stated_by_visitor(monkeypatch):
    import json

    async def unexpected_search(*args):
        raise AssertionError("reservation search must not run for a name the visitor did not say")

    monkeypatch.setattr(service.ReceptionDesk, "search_reservations", lambda _self, *args: unexpected_search(*args))
    agent = ReceptionAgent()
    result = json.loads(asyncio.run(agent.search_reservations("山田太郎", "14:00")))
    assert result == {"status": "invalid_request", "code": "customer_name_not_self_identified"}


def test_reception_agent_accepts_a_bare_name_answer_to_its_question(monkeypatch):
    import json
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from livekit.agents import llm

    searched = []
    reservation = Reservation(
        "event-name-answer",
        datetime(2026, 11, 7, 15, 0, tzinfo=ZoneInfo("Asia/Tokyo")),
        "佐藤花子",
        "サトウハナコ",
    )

    async def search(name, appointment_time):
        searched.append((name, appointment_time))
        return service.SearchResult("matched", (reservation,))

    monkeypatch.setattr(service.ReceptionDesk, "search_reservations", lambda _self, *args: search(*args))
    agent = ReceptionAgent()

    async def scenario():
        context = llm.ChatContext()
        context.add_message(role="assistant", content="ご予約のお名前をお伺いできますか。")
        name_answer = context.add_message(role="user", content="佐藤花子")
        await agent.on_user_turn_completed(context, name_answer)
        context.add_message(role="assistant", content="ご予約のお時間は何時ですか。")
        time_answer = context.add_message(role="user", content="15時")
        await agent.on_user_turn_completed(context, time_answer)
        return json.loads(await agent.search_reservations("佐藤花子", "15:00"))

    result = asyncio.run(scenario())

    assert result["status"] == "matched"
    assert result["reservation_id"] == "event-name-answer"
    assert searched == [("佐藤花子", "15:00")]


def test_reception_agent_does_not_treat_a_non_name_answer_as_a_name(monkeypatch):
    import json

    from livekit.agents import llm

    async def unexpected_search(*args):
        raise AssertionError("a non-name answer must not reach reservation search")

    monkeypatch.setattr(service.ReceptionDesk, "search_reservations", lambda _self, *args: unexpected_search(*args))
    agent = ReceptionAgent()
    context = llm.ChatContext()
    context.add_message(role="assistant", content="お名前を教えていただけますか。")
    answer = context.add_message(role="user", content="わかりません")
    asyncio.run(agent.on_user_turn_completed(context, answer))

    result = json.loads(asyncio.run(agent.search_reservations("わかりません", None)))

    assert result == {"status": "invalid_request", "code": "customer_name_not_self_identified"}


@pytest.mark.parametrize("utterance", ["さっき受付した佐藤です", "これで大丈夫ですか"])
def test_reception_agent_confirms_an_already_recorded_arrival_without_tools(utterance):
    from types import SimpleNamespace

    agent = ReceptionAgent()
    agent._arrivals.add("already-recorded-reservation")

    async def scenario():
        await agent.on_user_turn_completed(None, SimpleNamespace(text_content=utterance))
        return [chunk async for chunk in agent.llm_node(None, [], None)]

    replies = asyncio.run(scenario())

    assert replies == ["はい、来店受付は完了しています。ご案内した場所でお待ちください。"]
    assert agent._turn_outcomes == {}


def test_reception_agent_still_records_staff_notification_for_current_turn_arrival(monkeypatch):
    agent = ReceptionAgent()
    reservation_id = "current-turn-arrival"
    agent._arrivals.add(reservation_id)
    agent._turn_arrivals.add(reservation_id)
    agent._visitor_utterances.append("これで大丈夫ですか")
    agent._turn_outcomes["check_in"] = {
        "status": "checked_in",
        "reservation_id": reservation_id,
    }
    notifications = []

    async def notify_staff(event_id, reason):
        notifications.append((event_id, reason))
        agent._staff_attempted = True
        agent._record_tool_outcome(
            "notify_staff",
            {"status": "recorded", "reservation_id": event_id},
        )
        return '{"status":"recorded"}'

    monkeypatch.setattr(agent, "notify_staff", notify_staff)

    async def collect():
        return [chunk async for chunk in agent.llm_node(None, [], None)]

    replies = asyncio.run(collect())

    assert notifications == [(reservation_id, "予約客の来店")]
    assert replies == ["ご来店受付を済ませ、スタッフ向け受付一覧に記録しました。"]


def test_reception_agent_searches_with_a_name_spoken_in_hiragana(monkeypatch):
    import json
    from types import SimpleNamespace

    seen = []

    async def search(name, time):
        seen.append((name, time))
        return service.SearchResult("not_found")

    monkeypatch.setattr(service.ReceptionDesk, "search_reservations", lambda _self, *args: search(*args))
    agent = ReceptionAgent()
    asyncio.run(agent.on_user_turn_completed(None, SimpleNamespace(text_content="やまだたろうです。")))
    result = json.loads(asyncio.run(agent.search_reservations("やまだたろう", "14:00")))
    assert result == {"status": "not_found"}
    assert seen == [("やまだたろう", "14:00")]


def test_reception_agent_does_not_search_menu_questions_or_non_clock_times(monkeypatch):
    import json
    from types import SimpleNamespace
    from monban_backend.agent import ReceptionAgent

    async def unexpected_search(*args):
        raise AssertionError("menu details and durations must not reach reservation lookup")

    monkeypatch.setattr(service.ReceptionDesk, "search_reservations", lambda _self, *args: unexpected_search(*args))
    agent = ReceptionAgent()
    asyncio.run(
        agent.on_user_turn_completed(
            None,
            SimpleNamespace(text_content="ジェルネイルの予約をした佐藤花子です。どのメニューか教えてください。"),
        )
    )
    menu_result = json.loads(asyncio.run(agent.search_reservations("佐藤花子", "15:00")))
    assert menu_result == {
        "status": "invalid_request",
        "code": "search_not_applicable_to_service_question",
    }

    agent = ReceptionAgent()
    asyncio.run(
        agent.on_user_turn_completed(
            None,
            SimpleNamespace(text_content="15時の予約で佐藤花子です。来店受付をお願いします。"),
        )
    )
    asyncio.run(
        agent.on_user_turn_completed(
            None,
            SimpleNamespace(text_content="予約したジェルネイルのメニューを教えてください。"),
        )
    )
    prior_arrival_menu_result = json.loads(
        asyncio.run(agent.search_reservations("佐藤花子", "15:00"))
    )
    assert prior_arrival_menu_result == {
        "status": "invalid_request",
        "code": "search_not_applicable_to_service_question",
    }

    agent = ReceptionAgent()
    asyncio.run(
        agent.on_user_turn_completed(
            None, SimpleNamespace(text_content="整体60分の予約で来店受付をお願いします。佐藤花子です。")
        )
    )
    time_result = json.loads(asyncio.run(agent.search_reservations("佐藤花子", "60分")))
    assert time_result == {
        "status": "invalid_request",
        "code": "appointment_time_must_be_hh_mm_or_null",
    }


def test_tool_failure_uses_a_truthful_deterministic_handoff(monkeypatch):
    recorded = []
    monkeypatch.setattr(
        service.ReceptionDesk,
        "request_staff",
        lambda _self, reason: recorded.append(reason),
    )
    agent = ReceptionAgent()
    agent._turn_outcomes["search"] = {"status": "unavailable"}

    reply = asyncio.run(agent._deterministic_tool_failure_reply())

    assert "予約照合を完了できず" in reply
    assert "来店受付はまだ完了していません" in reply
    assert "予約情報が見つかりません" not in reply
    assert recorded == ["予約照合の失敗を確認"]


def test_llm_node_applies_search_failure_handoff_before_calling_the_model(monkeypatch):
    recorded = []
    monkeypatch.setattr(
        service.ReceptionDesk,
        "request_staff",
        lambda _self, reason: recorded.append(reason),
    )
    agent = ReceptionAgent()
    agent._turn_outcomes["search"] = {"status": "unavailable"}

    async def collect():
        return [chunk async for chunk in agent.llm_node(None, [], None)]

    replies = asyncio.run(collect())

    assert replies == [
        "予約照合を完了できず、来店受付はまだ完了していません。スタッフに確認を依頼しました。"
    ]
    assert recorded == ["予約照合の失敗を確認"]


def test_checkin_failure_cannot_be_reported_as_completed(monkeypatch):
    recorded = []
    monkeypatch.setattr(
        service.ReceptionDesk,
        "request_staff",
        lambda _self, reason: recorded.append(reason),
    )
    agent = ReceptionAgent()
    agent._turn_outcomes["check_in"] = {"status": "unavailable"}

    reply = asyncio.run(agent._deterministic_tool_failure_reply())

    assert "来店受付は完了できませんでした" in reply
    assert "来店受付を完了しました" not in reply
    assert len(recorded) == 1


def test_failed_staff_request_cannot_be_followed_by_a_success_claim():
    agent = ReceptionAgent()
    agent._turn_outcomes["request_staff"] = {
        "status": "error",
        "code": "invalid_reason",
    }

    async def collect():
        return [chunk async for chunk in agent.llm_node(None, [], None)]

    replies = asyncio.run(collect())

    assert replies == ["スタッフへの確認依頼を記録できませんでした。"]
    assert "受付のみ完了しました" not in replies[0]


def test_checkin_revalidates_booking_before_writing(supabase):
    import json
    from types import SimpleNamespace

    supabase.add("reservation-cancelled-after-search", "山田太郎", two_pm())
    agent = ReceptionAgent(desk())
    asyncio.run(agent.on_user_turn_completed(None, SimpleNamespace(text_content="山田太郎です。")))
    found = json.loads(asyncio.run(agent.search_reservations("山田太郎", "14:00")))
    assert found["status"] == "matched"
    supabase.reservations.clear()  # cancelled in the app after the search
    result = json.loads(asyncio.run(agent.check_in("reservation-cancelled-after-search")))
    assert result["status"] == "needs_staff"
    assert supabase.arrived == []


def test_runtime_tool_signatures_match_shared_model_contract():
    import inspect
    from monban_backend.agent import ReceptionAgent
    from monban_backend.reception.tool_schema_v17 import TOOL_SCHEMAS_V17

    agent = ReceptionAgent()
    contract = {
        name: schema["parameters"] for name, schema in TOOL_SCHEMAS_V17.items()
    }
    runtime = {tool._info.name for tool in agent._tools}
    assert runtime == set(contract)
    for name, schema in contract.items():
        parameters = inspect.signature(getattr(agent, name)).parameters
        assert set(parameters) == set(schema["properties"])
        required = {
            parameter_name
            for parameter_name, parameter in parameters.items()
            if parameter.default is inspect.Parameter.empty
        }
        assert required == set(schema["required"])


def test_prefetch_is_reused_by_search(supabase):
    supabase.add("reservation-1", "山田太郎", two_pm())
    reception = desk()

    async def scenario():
        await reception.prefetch()
        first = await reception.search_reservations("山田太郎", "14:00")
        second = await reception.search_reservations("山田太郎", "14:00")
        return first, second

    first, second = asyncio.run(scenario())
    assert first.status == second.status == "matched"
    assert supabase.list_calls == 1


def test_lookup_failure_is_not_cached_as_no_reservation(supabase):
    supabase.add("reservation-1", "山田太郎", two_pm())
    supabase.fail = True
    reception = desk()
    assert asyncio.run(reception.confirm("山田太郎", two_pm())).status == "unavailable"
    assert reception.staff_requests == ["山田太郎"]

    supabase.fail = False
    assert asyncio.run(reception.confirm("山田太郎", two_pm())).status == "arrived"
    assert supabase.arrived == ["reservation-1"]


def test_unpaired_device_never_matches_a_reservation():
    result = asyncio.run(service.ReceptionDesk(None).search_reservations("山田太郎", "14:00"))
    assert result.status == "unavailable"


def test_already_arrived_reservation_is_not_written_twice(supabase):
    supabase.add("reservation-1", "山田太郎", two_pm())
    reception = desk()
    reservation = Reservation("reservation-1", two_pm(), "山田太郎", "")
    assert asyncio.run(reception.record_arrival(reservation)).status == "arrived"
    assert asyncio.run(reception.record_arrival(reservation)).status == "already_arrived"
    assert supabase.arrived == ["reservation-1"]


