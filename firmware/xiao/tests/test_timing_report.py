import importlib.util
import pathlib
import sys
import unittest

spec = importlib.util.spec_from_file_location(
    "timing_report", pathlib.Path(__file__).resolve().parents[1] / "tools" / "timing_report.py")
timing_report = importlib.util.module_from_spec(spec)
# dataclasses look the module up by name while the file runs.
sys.modules[spec.name] = timing_report
spec.loader.exec_module(timing_report)

LOG = """\
[VOICE] Preparing streaming call.
[TIMING] event=call_start turn=0 ms=1000 epoch_ms=1794600000000
[TIMING] event=relay_ready turn=0 ms=1400 epoch_ms=1794600000400
[TIMING] event=call_press_requested turn=0 ms=1500 epoch_ms=1794600000500
[SERVO] CALL press once: 180 degrees for 300 ms; source=saved rest=0 pulse_us=1700 at_ms=2000
[TIMING] event=reply_start turn=0 ms=3000 epoch_ms=1794600002000
[TIMING] event=playback_start turn=0 ms=3700 epoch_ms=1794600002700
[TIMING] event=playback_done turn=0 ms=6000 epoch_ms=1794600005000
[TIMING] event=listen_start turn=1 ms=6200 epoch_ms=1794600005200
[TIMING] event=speech_end turn=1 ms=9000 epoch_ms=1794600008000
[TIMING] event=reply_start turn=1 ms=10200 epoch_ms=1794600009200
[TIMING] event=playback_start turn=1 ms=10900 epoch_ms=1794600009900
[TIMING] event=end_press_requested turn=1 ms=14000 epoch_ms=1794600013000
[TIMING] event=call_end turn=1 ms=15000 epoch_ms=1794600014000
[TIMING] event=call_start turn=0 ms=4294967000 epoch_ms=0
[TIMING] event=playback_start turn=0 ms=704 epoch_ms=0
"""


class TimingReportTest(unittest.TestCase):
    def test_intervals_per_call_and_turn(self):
        calls = timing_report.parse(LOG.splitlines())
        self.assertEqual(len(calls), 2)
        first = timing_report.measure(calls[0])
        self.assertEqual(first["chime_to_press_ms"], 500)
        self.assertEqual(first["chime_to_greeting_ms"], 2700)
        self.assertEqual(first["replies"], [{"turn": 1, "reply_heard_ms": 1900, "server_ms": 1200, "device_ms": 700}])
        self.assertTrue(first["ended"] and first["end_pressed"])

    def test_ms_clock_wrap_and_missing_events(self):
        second = timing_report.measure(timing_report.parse(LOG.splitlines())[1])
        self.assertEqual(second["chime_to_greeting_ms"], 1000)  # across the uint32 wrap
        self.assertIsNone(second["chime_to_press_ms"])
        self.assertEqual(second["replies"], [])
        self.assertFalse(second["ended"])

    def test_report_summarizes_fastest_median_slowest(self):
        text = timing_report.report(timing_report.parse(LOG.splitlines()))
        self.assertIn("チャイムから挨拶が聞こえるまで: 最速 1000 ms / 中央値 1850 ms / 最遅 2700 ms（2件）", text)
        self.assertIn("話し終えてから返答が聞こえるまで: 最速 1900 ms", text)
        self.assertIn("ターン1: 返答が聞こえるまで 1900 ms（サーバー側 1200 ms、端末側 700 ms）", text)


if __name__ == "__main__":
    unittest.main()
