from door_backend.house_rules import (
    DELIVERY_AWAY,
    DELIVERY_AWAY_LEAVE_AT_DOOR,
    DELIVERY_HOME,
    EXTRA_HEAD,
    HouseSettings,
    base_rules,
    build_house_rules,
    extra_instructions_capacity,
)


def test_home_modes_ask_to_leave_parcels_at_the_door():
    for mode in ("normal", "omakase"):
        rules = build_house_rules(mode, None, 800)
        assert DELIVERY_HOME in rules
        assert DELIVERY_AWAY not in rules


def test_leave_at_door_permission_only_changes_away_mode():
    allowed = HouseSettings(away_leave_at_door=True)
    assert DELIVERY_AWAY in build_house_rules("away", None, 800)
    assert DELIVERY_AWAY in build_house_rules("away", HouseSettings(away_leave_at_door=False), 800)
    assert DELIVERY_AWAY_LEAVE_AT_DOOR in build_house_rules("away", allowed, 800)
    assert build_house_rules("normal", allowed, 800) == base_rules("normal")


def test_extra_instructions_follow_the_base_rules():
    rules = build_house_rules("omakase", HouseSettings(extra_instructions="  宗教の勧誘も断ってください。\n"), 800)
    assert rules == f"{base_rules('omakase')}\n{EXTRA_HEAD}\n宗教の勧誘も断ってください。"
    assert build_house_rules("normal", HouseSettings(extra_instructions=" \n "), 800) == base_rules("normal")


def test_long_extra_instructions_are_cut_to_the_limit():
    house = HouseSettings(away_leave_at_door=True, extra_instructions="あ" * 1000)
    for mode in ("normal", "omakase", "away"):
        rules = build_house_rules(mode, house, 800)
        assert len(rules) == 800
        assert rules.startswith(base_rules(mode, True) + "\n" + EXTRA_HEAD)
    assert build_house_rules("away", house, len(base_rules("away", True))) == base_rules("away", True)


def test_capacity_fits_the_longest_mode():
    capacity = extra_instructions_capacity(800)
    house = HouseSettings(away_leave_at_door=True, extra_instructions="い" * capacity)
    assert build_house_rules("away", house, 800).endswith("い" * capacity)
