"""Offline regressions for the deployed DoorAgent policy; no model/service calls."""
from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
import unittest

from monban_backend.voice.visit_policy import VisitState

AGENT_PATH = Path(__file__).resolve().parents[1] / "monban_backend/voice/agent.py"

def state(text, *, previous=None):
    return VisitState.from_messages((previous or []) + [("user", text)], "玄関の前に置いてください。")


def actual_door_reply(messages):
    """Run the actual DoorAgent class AST, replacing only its network/model boundary."""
    model_calls = []

    class FakeAgent:
        def __init__(self, **kwargs):
            pass

        class default:
            @staticmethod
            async def llm_node(*args, **kwargs):
                model_calls.append(True)
                yield "追加のご用件について承知しました。"

    tree = ast.parse(AGENT_PATH.read_text())
    node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "DoorAgent")
    env = {
        "Agent": FakeAgent, "VisitState": VisitState, "StopResponse": RuntimeError,
        "settings": SimpleNamespace(max_house_rules_chars=800, house_rules="玄関の前に置いてください。"),
        "BASE_INSTRUCTIONS": "{house_rules}",
        "_context_with_state_instructions": lambda ctx, instructions: ctx,
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(AGENT_PATH), "exec"), env)
    agent = env["DoorAgent"]("玄関の前に置いてください。")
    chat = SimpleNamespace(items=[SimpleNamespace(type="message", role=role, text_content=text) for role, text in messages])

    async def run():
        return "".join([chunk async for chunk in agent.llm_node(chat, [], None)])

    return asyncio.run(run()), len(model_calls)


class ClosureRegressions(unittest.TestCase):
    def test_final_thanks_with_unknown_purpose_uses_farewell_without_llm(self):
        messages = [
            ("user", "でも最初答えてたから"),
            ("assistant", "恐れ入りますが、お名前はお伝えできません。"),
            ("user", "大丈夫です"), ("assistant", "はい、大丈夫です。"),
            ("user", "ありがとうございました"),
        ]
        result = VisitState.from_messages(messages)
        self.assertTrue(result.closing)
        reply, calls = actual_door_reply(messages)
        self.assertEqual(reply, "失礼いたします。")
        self.assertEqual(calls, 0)
        self.assertTrue(result.validate(reply))

    def test_clear_departure_variants(self):
        for text in ["失礼します", "失礼いたします", "はい、失礼いたします。", "では、失礼します。", "ありがとうございました", "どうもありがとうございました。", "ありがとうございました。失礼します。", "荷物を置きました。失礼いたします。"]:
            with self.subTest(text=text):
                result = state(text)
                self.assertTrue(result.closing)
                self.assertEqual(result.fallback(), "失礼いたします。")

    def test_present_thanks_during_delivery_is_not_departure(self):
        previous = [("user", "宅急便です"), ("assistant", "玄関の前に置いていただけますか。")]
        for text in ["ありがとう", "ありがとうございます", "どうも", "はい、ありがとうございます。", "置いておきます", "よろしくお願いします"]:
            with self.subTest(text=text):
                result = state(text, previous=previous)
                self.assertFalse(result.closing)
                self.assertFalse(result.placed)
                self.assertFalse(result.validate("失礼いたします。"))

    def test_new_request_and_quoted_farewell_do_not_close(self):
        for text in [
            "ありがとうございました。あと一つ質問です。", "ありがとう、置き場所はどこですか。",
            "失礼しますというかどうすればいいですか", "失礼しますが、サインをお願いします。",
            "先方には「失礼します」と伝えてください", "「ありがとうございました」と言えばいいですか。",
            "ありがとうございましたと伝えてください", "夜分に失礼いたします。宅急便です。",
            "夜分に失礼いたします", "さようならと言われました。", "配達員の発言を引用します。ありがとうございました。",
        ]:
            with self.subTest(text=text):
                self.assertFalse(state(text).closing)

    def test_promise_to_return_later_closes_like_main(self):
        # These closed on main; "あとで" must not be read as "あと" (another request).
        for text in [
            "あとでまた来ます", "あとで伺います", "失礼します。また来ます", "失礼しますまた来ます",
            "また来ます", "改めて伺います", "後でまた来ます", "ありがとうございました。また来ます",
            "じゃあまた来ますね", "失礼しますね",
        ]:
            with self.subTest(text=text):
                result = state(text)
                self.assertTrue(result.closing)
                self.assertEqual(result.deterministic_reply, "失礼いたします。")

    def test_after_and_desune_still_mark_a_follow_up(self):
        for text in ["ありがとうございました。あとですね、サインをお願いします。", "あと、伝票にサインをお願いします。"]:
            with self.subTest(text=text):
                self.assertFalse(state(text).closing)

    def test_explicit_parcel_completion_recovers_unknown_purpose(self):
        for text in ["荷物を置きました", "お荷物は玄関の前に置いておきました", "荷物を置いてきました"]:
            with self.subTest(text=text):
                result = state(text, previous=[("user", "こんにちは"), ("assistant", "ご用件をお聞かせください。")])
                self.assertEqual(result.purpose, "delivery")
                self.assertTrue(result.placed)
                reply, calls = actual_door_reply([("user", "こんにちは"), ("assistant", "ご用件をお聞かせください。"), ("user", text)])
                self.assertEqual(reply, "失礼いたします。")
                self.assertEqual(calls, 0)

    def test_nonparcel_placement_does_not_invent_delivery(self):
        self.assertFalse(state("花瓶を置きました").placed)
        self.assertEqual(state("花瓶を置きました").purpose, "unknown")

    def test_placement_questions_quotes_negatives_and_future_remain_open(self):
        previous = [("user", "宅急便です"), ("assistant", "玄関の前に置いていただけますか。")]
        for text in [
            "まだ置いていません", "まだ置いてないです", "置きません", "これから置きます", "置いておきます",
            "置きましたか", "置いたらいいですか", "置いたことにしてください", "入れたらいいですか",
            "「置きました」とは言っていません", "置きましたと言っていました", "置きましたが、まだ置いていません",
            "荷物を置いたわけではありません", "荷物を置いたことはありません", "荷物を置いたのではありません",
        ]:
            with self.subTest(text=text):
                result = state(text, previous=previous)
                self.assertFalse(result.placed)
                self.assertFalse(result.closing)

    def test_later_negative_correction_clears_placed(self):
        for text in ["訂正です、まだ置いていません", "荷物を置いたわけではありません", "荷物を置いたことはありません"]:
            with self.subTest(text=text):
                result = state(text, previous=[("user", "宅急便です"), ("user", "荷物を置きました")])
                self.assertFalse(result.placed)

    def test_completed_dropoff_with_outstanding_request_is_not_closed(self):
        previous = [("user", "宅急便です"), ("assistant", "玄関の前に置いてください。")]
        for text in ["荷物を置きました。あと伝票にサインをお願いします。", "荷物を置きました。これで大丈夫ですか。", "荷物を置きました。サインしてください。", "荷物を置きました。まだ別の荷物があります。"]:
            with self.subTest(text=text):
                result = state(text, previous=previous)
                self.assertTrue(result.placed)
                self.assertFalse(result.closing)
                self.assertNotEqual(result.deterministic_reply, "失礼いたします。")
                self.assertNotEqual(result.fallback(), "失礼いたします。")
                self.assertFalse(result.validate("失礼いたします。"))

    def test_final_thanks_is_not_repeated_after_agent_farewell(self):
        result = state("ありがとうございました", previous=[("user", "宅急便です"), ("assistant", "失礼いたします。")])
        self.assertTrue(result.closing_said)
        self.assertTrue(result.should_wait)

    def test_delivery_labels_follow_the_completed_task(self):
        messages = [("user", "荷物のお届けに来ました"), ("assistant", "玄関の前に置いていただけますか。"), ("user", "宅急便です"), ("assistant", "はい、玄関の前にお願いします。"), ("user", "荷物を置きました")]
        result = VisitState.from_messages(messages)
        self.assertTrue(result.placed)
        self.assertEqual(result.deterministic_reply, "失礼いたします。")
        after = VisitState.from_messages(messages + [("assistant", "失礼いたします。"), ("user", "ありがとうございました")])
        self.assertTrue(after.should_wait)

    def test_completion_is_not_carried_to_a_new_session(self):
        self.assertTrue(state("荷物を置きました").placed)
        fresh = state("ありがとうございます")
        self.assertFalse(fresh.placed)
        self.assertFalse(fresh.closing)


if __name__ == "__main__":
    unittest.main(verbosity=2)
