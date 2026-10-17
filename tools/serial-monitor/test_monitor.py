"""Focused state-machine, byte-stream, and HTTP boundary tests.

Run: python3 -m unittest discover -s monitor -p 'test_*.py' -v
No board, network service, or third-party package is required.
"""

import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

from monitor import LineFramer, MAX_LINE_BYTES, MAX_LINE_CHARS, MAX_LOG_LINES, MonitorState, make_handler


HEALTH = '[SERVER] /health HTTP 200; body (15 bytes): {"status":"ok"}'
STATUS_BODY = {"asr": {"model": "kotoba-whisper", "ready": True},
               "tts": {"model": "Irodori", "voice": "door_neutral", "ready": True},
               "llm": {"model": "gemma4:latest"}}
STATUS = '[SERVER] /v1/status HTTP 200; body (176 bytes): ' + json.dumps(STATUS_BODY)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.state = MonitorState(now=1000)
        self.state.serial_connected("/dev/cu.usbmodem-test", now=1000)

    def line(self, text, at=1001):
        self.state.accept_line(text, now=at)

    def successful_check(self, at=1001):
        self.line("[OK] Wi-Fi connected + DHCP OK. IP: 172.20.10.2", at)
        self.line("[SERVER] Check started.", at)
        self.line("[SERVER] HTTPS GET /health (certificate and hostname verification enabled).", at)
        self.line(HEALTH, at + 1)
        self.line("[SERVER] HTTPS GET /v1/status (certificate and hostname verification enabled).", at + 1)
        self.line(STATUS, at + 2)
        self.line("[SERVER] HTTPS health and status checks passed.", at + 2)
        self.line("[SERVER] Check complete: passed. Next check in 60 seconds.", at + 2)

    def test_success_preserves_real_model_types(self):
        self.successful_check()
        state = self.state.snapshot(now=1004)
        self.assertEqual(state["wifi"]["ip"], "172.20.10.2")
        self.assertEqual(state["server"]["state"], "ok")
        self.assertEqual(state["server"]["last_success_at"], 1003)
        self.assertTrue(state["models"]["asr"]["ready"])
        self.assertNotIn("ready", state["models"]["llm"])

    def test_no_telemetry_invalidates_green_states_without_mutating_evidence(self):
        self.successful_check()
        stale = self.state.snapshot(now=1040)
        self.assertEqual(stale["wifi"]["state"], "stale")
        self.assertEqual(stale["server"]["state"], "stale")
        self.assertEqual(stale["server"]["last_success_at"], 1003)
        self.assertEqual(self.state.server["state"], "ok")

    def test_repeated_legacy_passed_never_updates_verification(self):
        self.successful_check()
        for at in range(1010, 1170, 10):
            self.line("[OK] Wi-Fi connected + DHCP OK. IP: 172.20.10.2", at)
            self.line("[SERVER] Last HTTPS health/status check: passed.", at)
        state = self.state.snapshot(now=1161)
        self.assertEqual(state["wifi"]["state"], "connected")
        self.assertEqual(state["server"]["state"], "stale")
        self.assertEqual(state["server"]["last_check_at"], 1003)
        self.assertEqual(state["server"]["last_success_at"], 1003)

    def test_legacy_passed_without_observed_request_does_not_invent_success(self):
        self.line("[SERVER] Last HTTPS health/status check: passed.")
        self.assertEqual(self.state.snapshot(now=1002)["server"]["state"], "unknown")

    def test_disconnect_invalidates_live_status_reconnect_clears_evidence(self):
        self.successful_check()
        self.state.serial_disconnected("USB disconnected", now=1005)
        disconnected = self.state.snapshot(now=1006)
        self.assertFalse(disconnected["serial"]["connected"])
        self.assertEqual(disconnected["wifi"]["state"], "unknown")
        self.assertEqual(disconnected["server"]["state"], "unknown")
        self.state.serial_connected("/dev/cu.usbmodem-test2", now=1007)
        reconnected = self.state.snapshot(now=1008)
        self.assertIsNone(reconnected["wifi"]["ip"])
        self.assertIsNone(reconnected["server"]["last_success_at"])
        self.assertIsNone(reconnected["models"]["asr"]["ready"])

    def test_reboot_clears_scan_models_and_endpoints(self):
        self.successful_check()
        self.line("[SCAN] Configured network found: channel 6, signal -51 dBm, WPA2-AES-Personal (0x00000000).", 1004)
        self.line("CY8CPROTO-062-4343W Wi-Fi / Door API HTTPS test", 1005)
        state = self.state.snapshot(now=1006)
        self.assertEqual(state["wifi"]["state"], "unknown")
        self.assertIsNone(state["wifi"]["rssi"])
        self.assertIsNone(state["server"]["endpoints"]["/health"]["status"])
        self.assertIsNone(state["models"]["asr"]["ready"])
        self.assertTrue(state["serial"]["connected"])

    def test_startup_scan_has_its_own_timestamp(self):
        self.line("[SCAN] Configured network found: channel 6, signal -51 dBm, WPA2-AES-Personal (0x00000000).")
        self.line("[OK] Wi-Fi connected + DHCP OK. IP: 172.20.10.2", 1010)
        state = self.state.snapshot(now=1011)
        self.assertEqual(state["wifi"]["rssi"], -51)
        self.assertEqual(state["wifi"]["scan_at"], 1001)
        self.assertEqual(state["wifi"]["last_seen_at"], 1010)

    def test_failure_after_success_does_not_reuse_old_endpoint_results(self):
        self.successful_check()
        self.line("[SERVER] Check started.", 1065)
        self.line("[SERVER] DNS lookup failed: 0x1234. Check Internet/DNS access.", 1066)
        self.line("[SERVER] Check complete: failed. Next check in 60 seconds.", 1066)
        state = self.state.snapshot(now=1067)
        self.assertEqual(state["server"]["state"], "error")
        self.assertEqual(state["server"]["last_success_at"], 1003)
        self.assertEqual(state["server"]["last_check_at"], 1066)
        self.assertIn("DNS", state["server"]["error"])
        self.assertIsNone(state["server"]["endpoints"]["/health"]["status"])
        self.assertIsNone(state["models"]["asr"]["ready"])

    def test_http_200_does_not_make_unhealthy_body_ok(self):
        self.line("[SERVER] Check started.")
        self.line('[SERVER] /health HTTP 200; body (20 bytes): {"status":"degraded"}', 1002)
        self.line(STATUS, 1003)
        self.line("[SERVER] Check complete: failed. Next check in 60 seconds.", 1004)
        state = self.state.snapshot(now=1005)
        self.assertEqual(state["server"]["state"], "error")
        self.assertIsNotNone(state["server"]["endpoints"]["/health"]["error"])

    def test_model_not_ready_is_not_communication_failure(self):
        self.line("[SERVER] Check started.")
        self.line(HEALTH, 1002)
        self.line(STATUS.replace('"ready": true', '"ready": false'), 1003)
        self.line("[SERVER] Check complete: passed. Next check in 60 seconds.", 1004)
        state = self.state.snapshot(now=1005)
        self.assertEqual(state["server"]["state"], "ok")
        self.assertIs(state["models"]["asr"]["ready"], False)
        self.assertIs(state["models"]["tts"]["ready"], False)

    def test_invalid_json_cannot_create_success_or_ready(self):
        for invalid in ('{"asr":', '[]', 'null', '{"asr": NaN}'):
            with self.subTest(invalid=invalid):
                self.line("[SERVER] Check started.")
                self.line(HEALTH, 1002)
                self.line('[SERVER] /v1/status HTTP 200; body (10 bytes): ' + invalid, 1003)
                self.line("[SERVER] Check complete: passed. Next check in 60 seconds.", 1004)
                state = self.state.snapshot(now=1005)
                self.assertEqual(state["server"]["state"], "error")
                self.assertIsNone(state["models"]["asr"]["ready"])

    def test_string_ready_is_unknown_and_http_error_is_failure(self):
        self.line("[SERVER] Check started.")
        self.line(HEALTH, 1002)
        self.line(STATUS.replace('"ready": true', '"ready": "false"'), 1003)
        self.assertIsNone(self.state.snapshot(now=1003)["models"]["asr"]["ready"])
        self.line('[SERVER] /v1/status HTTP 503; body (20 bytes): {"error":"unavailable"}', 1004)
        self.line("[SERVER] Check complete: failed. Next check in 60 seconds.", 1005)
        self.assertEqual(self.state.snapshot(now=1006)["server"]["state"], "error")

    def test_wifi_loss_invalidates_server_and_dhcp_waits_for_fresh_ip(self):
        self.successful_check()
        self.line("[Wi-Fi] Connection lost. Waiting for automatic reconnect.", 1004)
        self.assertEqual(self.state.snapshot(now=1005)["server"]["state"], "unknown")
        self.line("[Wi-Fi] Reconnected.", 1006)
        state = self.state.snapshot(now=1007)
        self.assertEqual(state["wifi"]["state"], "connecting")
        self.assertIsNone(state["wifi"]["ip"])

    def test_invalid_ip_is_not_connected(self):
        self.line("[OK] Wi-Fi connected + DHCP OK. IP: 999.20.10.2")
        self.assertEqual(self.state.snapshot(now=1002)["wifi"]["state"], "error")

    def test_ntp_result_is_observed_separately(self):
        self.line("[TIME] Synchronizing clock with time.google.com...")
        self.assertEqual(self.state.snapshot(now=1001)["clock"]["state"], "syncing")
        self.line("[TIME] UTC 2026-10-17 03:47:34", 1002)
        self.assertEqual(self.state.snapshot(now=1003)["clock"]["utc"], "2026-10-17T03:47:34Z")

    def test_logs_are_bounded_and_control_sequences_removed(self):
        for i in range(MAX_LOG_LINES + 10):
            self.line("\x1b[31m" + str(i) + "x" * 3000 + "\x00")
        logs = self.state.snapshot(now=1002)["logs"]
        self.assertEqual(len(logs), MAX_LOG_LINES)
        self.assertEqual(len(logs[-1]["text"]), MAX_LINE_CHARS)
        self.assertNotIn("\x1b", logs[-1]["text"])
        self.assertNotIn("\x00", logs[-1]["text"])


class FramerTests(unittest.TestCase):
    def test_split_multibyte_crlf_and_multiple_lines(self):
        framer = LineFramer()
        stream = "first\r\n日本語\nlast\r".encode()
        result = []
        for byte in stream:
            result.extend(framer.feed(bytes([byte])))
        self.assertEqual(result, ["first", "日本語", "last"])

    def test_overlong_line_does_not_grow_buffer_and_next_line_recovers(self):
        framer = LineFramer()
        self.assertEqual(framer.feed(b"x" * (MAX_LINE_BYTES * 2)), [])
        self.assertEqual(len(framer.pending), MAX_LINE_BYTES)
        lines = framer.feed(b"\nOK\n")
        self.assertLessEqual(len(lines[0]), MAX_LINE_CHARS)
        self.assertIn("truncated", lines[0])
        self.assertEqual(lines[1], "OK")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        Path(cls.temp.name, "index.html").write_text("<html>monitor</html>")
        cls.state = MonitorState(now=1000)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.state, 0, cls.temp.name))
        cls.port = cls.httpd.server_port
        cls.httpd.RequestHandlerClass = make_handler(cls.state, cls.port, cls.temp.name)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.thread.join(timeout=2)
        cls.httpd.server_close()
        cls.temp.cleanup()

    def request(self, path="/api/state", method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_state_is_json_and_initial_state_is_not_connected(self):
        code, headers, body = self.request()
        self.assertEqual(code, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        state = json.loads(body)
        self.assertFalse(state["serial"]["connected"])
        self.assertEqual(state["server"]["state"], "unknown")

    def test_foreign_host_or_origin_is_rejected(self):
        self.assertEqual(self.request(headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request(headers={"Origin": "https://attacker.example"})[0], 403)

    def test_static_only_and_no_mutation_routes(self):
        self.assertEqual(self.request("/")[0], 200)
        self.assertEqual(self.request("/../monitor.py")[0], 404)
        self.assertEqual(self.request("/%2e%2e/monitor.py")[0], 404)
        self.assertEqual(self.request(method="POST")[0], 405)


if __name__ == "__main__":
    unittest.main()
