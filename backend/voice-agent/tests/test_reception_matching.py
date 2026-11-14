from datetime import datetime

from monban_backend.persistence.device_api import parse_reservation as parse_remote
from monban_backend.reception.matching import Reservation, match_reservations
from monban_backend.reception.service import _to_reservation


def reservation(reservation_id="reservation-1"):
    return Reservation(reservation_id, datetime.fromisoformat("2026-11-01T14:00:00+09:00"), "山田太郎", "ヤマダタロウ")


def test_match_normalizes_kana_and_limits_time():
    item = reservation()
    assert match_reservations([item], "やまだ たろう様", datetime.fromisoformat("2026-11-01T14:15:00+09:00")) == [item]
    assert not match_reservations([item], "山田", item.start)
    assert not match_reservations([item], "山田太郎", datetime.fromisoformat("2026-11-01T14:16:00+09:00"))


def test_early_arrival_inside_the_window_is_not_excluded():
    item = reservation()
    assert match_reservations([item], "山田太郎", datetime.fromisoformat("2026-11-01T13:45:00+09:00")) == [item]


def test_ambiguous_results_are_not_silently_resolved():
    first, second = reservation(), reservation("reservation-2")
    assert len(match_reservations([first, second], "山田太郎", first.start)) == 2


def remote(**changes):
    return {
        "id": "reservation-1",
        "customer_name": "山田太郎",
        "service_name": "ジェルネイル",
        "starts_at": "2026-11-01T05:00:00.000Z",
        "ends_at": "2026-11-01T06:00:00.000Z",
        "status": "confirmed",
        "arrived_at": None,
        **changes,
    }


def test_supabase_reservations_become_matchable_reservations():
    item = _to_reservation(parse_remote(remote()))
    assert item.event_id == "reservation-1"
    assert item.start == datetime.fromisoformat("2026-11-01T14:00:00+09:00")
    assert not item.arrived
    assert match_reservations([item], "山田太郎", datetime.fromisoformat("2026-11-01T14:10:00+09:00")) == [item]
    assert _to_reservation(parse_remote(remote(arrived_at="2026-11-01T05:01:00.000Z"))).arrived


def test_invalid_supabase_rows_do_not_become_reservations():
    assert parse_remote(remote(starts_at="2026-11-01T14:00:00")) is None  # no time zone
    assert parse_remote(remote(customer_name=None)) is None
    assert parse_remote(remote(id="")) is None
    assert parse_remote(["not", "an", "object"]) is None
