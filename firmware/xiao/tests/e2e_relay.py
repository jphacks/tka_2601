#!/usr/bin/env python3
"""Real backend /api/relay v2 code against the firmware's real call code.

Only the speech models are replaced (the backend's own test double, FakeAgent),
and only the hardware on the firmware side. No TLS and no real audio.
Run with a Python that has backend/voice-agent installed: bash run.sh e2e
"""
from pathlib import Path
import re
import socket
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))

BINARY = sys.argv.pop(1)
from e2e_backend import Agent, Backend, api  # noqa: E402


def firmware(port, scenario):
    result = subprocess.run([BINARY, str(port), scenario], capture_output=True, text=True, timeout=120)
    return result.returncode, result.stdout + result.stderr


def counters(log):
    match = re.search(r"\[E2E\] call_presses=(\d+) end_presses=(\d+) spoken_samples=(\d+) speaker_starts=(\d+) speaker_stops=(\d+) detected=(\d+)", log)
    assert match, log
    return [int(value) for value in match.groups()]


def assert_order(test, log, *markers):
    position = 0
    for marker in markers:
        found = log.find(marker, position)
        test.assertGreaterEqual(found, 0, f"missing {marker!r} after byte {position}\n{log}")
        position = found + len(marker)


class WholeCall(unittest.TestCase):
    def conversation(self, scenario):
        with Backend() as backend:
            code, log = firmware(backend.port, scenario)
            self.assertEqual(code, 0, log)
            self.assertNotIn("sanitizer", log.lower(), log)
            assert_order(self, log,
                         "[VOICE] Preparing streaming call.",
                         "[VOICE] Server ready: /api/relay protocol 2.",  # the API is proven before the button
                         "[SERVO] CALL press once:",
                         "[SERVO] CALL released;",
                         "[VOICE] Call button operation complete",
                         "[VOICE] Response 0:",
                         "[VOICE] Output ended: 121 frames",
                         "[VOICE] Playback complete: turn 0.",
                         "[VOICE] Listening: turn 1;",
                         "[VOICE] Input streaming:",
                         "[VOICE] Input complete:",
                         "[VOICE] Response 1:",
                         "[VOICE] Output ended: 61 frames",
                         "[VOICE] Playback complete: turn 1.",
                         "[SERVO] END press once:",
                         "[SERVO] END released;",
                         "[VOICE] Call ending: reason=completed",
                         "[VOICE] Call ended; chime detection rearmed.")
            self.assertNotIn("Server rejected", log)
            calls, ends, samples, starts, stops, detected = counters(log)
            self.assertEqual((calls, ends), (1, 1))
            self.assertEqual(samples, (120 + 60) * 320 + 2 * 100)  # every sample, including short final frames
            self.assertEqual((starts, stops), (2, 2))
            agent = Agent.instances[0]
            self.assertEqual(len(agent.recognized), 1)
            pcm = agent.recognized[0]
            self.assertEqual(len(pcm) % 640, 0)
            self.assertGreater(len(pcm), 640 * 60)  # speech, its pre-roll and 1.2 s of silence
            self.assertLess(len(pcm), 640 * (10 + 60 + 70))
            self.assertTrue(agent.closed)
            self.assertEqual(len(backend.visits), 1)
            return detected

    def test_manual_call_full_conversation(self):
        self.assertEqual(self.conversation("manual"), 0)

    def test_chime_starts_the_call(self):
        self.assertEqual(self.conversation("chime"), 1)

    def test_stop_during_greeting_ends_the_intercom_call(self):
        with Backend() as backend:
            code, log = firmware(backend.port, "stop")
            self.assertEqual(code, 0, log)
            assert_order(self, log, "[VOICE] Response 0:", "[VOICE] Call ending: reason=manual_stop",
                         "[SERVO] END press once:", "[VOICE] Call stopped; chime detection rearmed.")
            calls, ends, samples, starts, stops, _ = counters(log)
            self.assertEqual((calls, ends), (1, 1))
            self.assertLess(samples, 120 * 320)
            self.assertEqual(starts, stops)  # the amplifier is off again

    def test_unreachable_server_never_presses_the_intercom_button(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        code, log = firmware(port, "manual")
        self.assertEqual(code, 0, log)
        assert_order(self, log, "[VOICE] TLS connection failed.", "[VOICE] API unreachable (server_connect_failed)",
                     "[VOICE] Call ending: reason=server_connect_failed", "[VOICE] Call stopped; chime detection rearmed.")
        self.assertNotIn("[SERVO] CALL press", log)
        self.assertNotIn("[SERVO] END press", log)
        self.assertEqual(counters(log)[:3], [0, 0, 0])

    def test_rejected_api_key_is_a_failed_call(self):
        saved = api.settings.api_key
        object.__setattr__(api.settings, "api_key", "b" * 64)
        try:
            with Backend() as backend:
                code, log = firmware(backend.port, "manual")
        finally:
            object.__setattr__(api.settings, "api_key", saved)
        self.assertEqual(code, 0, log)
        assert_order(self, log, "[VOICE] API unreachable", "[VOICE] Call ending: reason=server_connect_failed",
                     "[VOICE] Call stopped; chime detection rearmed.")
        self.assertNotIn("[SERVO] CALL press", log)
        self.assertEqual(counters(log)[:3], [0, 0, 0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
