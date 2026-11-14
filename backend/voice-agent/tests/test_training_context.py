import importlib.util
from pathlib import Path
import pytest

TRAINING_CONTEXT = Path(__file__).parents[1] / "model_lab/training_context.py"
if not TRAINING_CONTEXT.exists():
    # model_lab (training data and scripts) is kept out of the repository.
    pytest.skip("model_lab is not present in this checkout", allow_module_level=True)

spec = importlib.util.spec_from_file_location("public_training_context", TRAINING_CONTEXT)
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


def test_legacy_policy_is_preserved():
    assert context.compose_system_prompt("policy") == "policy"


def test_empty_store_context_keeps_public_context_envelope():
    prompt = context.compose_system_prompt("policy", {})
    assert prompt == 'policy\n\n店舗の公開設定（未設定の項目は不明）:\n{}'


def test_public_context_is_deterministic_and_does_not_mutate():
    settings = {"shop_name": "架空店舗", "closing_time": "18時15分"}
    expected = context.compose_system_prompt("policy", settings)
    assert expected == context.compose_system_prompt("policy", dict(reversed(list(settings.items()))))
    assert settings == {"shop_name": "架空店舗", "closing_time": "18時15分"}


def test_configured_public_values_override_pending_reservation_flow_without_tools():
    prompt = context.compose_system_prompt(
        "policy", {"delivery_location": "入口左の受取カウンター"}
    )
    assert "予約確認の途中でも来訪者が別の質問をしたら" in prompt
    assert "設定値で回答できる質問にはrequest_staffなどのツールを使いません" in prompt
    assert "closing_timeは閉店時刻、closed_dayは定休日" in prompt
    assert "payment_methodsは支払方法" in prompt
    assert "荷物置き場の確認依頼を出しません" in prompt


def test_business_visit_policies_are_serialized_independently():
    settings = {"sales_policy": "polite_decline", "fee_collection_policy": "staff_handoff"}
    prompt = context.compose_system_prompt("policy", settings)
    assert "営業訪問: ツールを呼ばず、短く丁寧にお断りする。" in prompt
    assert "集金訪問: スタッフへ一度だけ確認依頼する。" in prompt
    assert "予約検索・来店受付・受付一覧への来店記録はしない" in prompt
    assert "支払いの要否や契約状態を推測しない。" in prompt
    assert "予約者名や予約時刻を尋ねない。" in prompt


def test_public_and_business_context_order_is_deterministic():
    first = {"shop_name": "架空店舗", "sales_policy": "staff_handoff", "fee_collection_policy": "polite_decline"}
    second = dict(reversed(list(first.items())))
    assert context.compose_system_prompt("policy", first) == context.compose_system_prompt("policy", second)


@pytest.mark.parametrize("settings", [
    {"private_customer_name": "山田"}, {"closing_time": None}, {"address": ""},
    {"address": "x" * 501}, ["address"], {"sales_policy": "auto_admit"},
    {"fee_collection_policy": None}, {"sales_policy": []},
])
def test_unsupported_or_invalid_context_is_rejected(settings):
    with pytest.raises(ValueError):
        context.compose_system_prompt("policy", settings)
