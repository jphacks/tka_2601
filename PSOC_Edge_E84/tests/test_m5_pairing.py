"""Pairing uses synthetic credentials in an isolated pair of projects."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pairing_configure_wifi", ROOT / "configure_wifi.py")
wifi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wifi)
TOKEN = "b" * 64
SSID = '試験 "Wi\\Fi"'
PASSWORD = 'test-"pass\\word'


class PairingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "PSOC_Edge_E84"
        (self.root / "source").mkdir(parents=True)
        self.receiver = self.base / "M5Stack_Basic_E84_Link"
        self.receiver.mkdir()
        shutil.copyfile(ROOT / "configure_m5.py", self.root / "configure_m5.py")
        self.wrapper = self.root / "source/m5_settings.h"
        self.wrapper.write_text("#pragma once\n")
        self.wifi_header = self.root / "source/wifi_config.h"
        self.wifi_header.write_text(wifi.configuration(SSID, PASSWORD, hotspot=True), encoding="utf-8")

    def run_config(self, *arguments, success=True):
        result = subprocess.run([sys.executable, str(self.root / "configure_m5.py"), *arguments],
                                cwd=self.base, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        for private in (SSID, PASSWORD, TOKEN):
            self.assertNotIn(private, result.stdout + result.stderr)
        return result

    def state(self):
        return json.loads((self.root / ".m5-link.json").read_text())

    def snapshot(self):
        return {str(path.relative_to(self.base)): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in (self.root / ".m5-link.json", self.root / "source/m5_config.h",
                             self.receiver / "link_config.h", self.wrapper) if path.exists()}

    def test_two_phase_keeps_token_port_and_uses_script_relative_paths(self):
        self.run_config("--prepare-receiver", "--port", "9876")
        initial = self.state()
        self.assertNotIn("host", initial)
        self.assertFalse((self.root / "source/m5_config.h").exists())
        receiver_before = (self.receiver / "link_config.h").read_bytes()
        self.run_config("--host", "172.20.10.4")
        self.assertEqual(self.state(), dict(initial, host="172.20.10.4"))
        self.assertEqual((self.receiver / "link_config.h").read_bytes(), receiver_before)
        self.run_config("--host", "172.20.10.5")
        self.assertEqual(self.state(), dict(initial, host="172.20.10.5"))
        self.run_config("--prepare-receiver")
        self.assertEqual(self.state(), dict(initial, host="172.20.10.5"))
        for path in (self.root / ".m5-link.json", self.root / "source/m5_config.h",
                     self.receiver / "link_config.h"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertIn(initial["token"], (self.root / "source/m5_config.h").read_text())
        self.assertIn(initial["token"], (self.receiver / "link_config.h").read_text())

    @unittest.skipUnless(shutil.which("cc"), "A C compiler is needed to verify generated literals")
    def test_utf8_and_escaping_reach_receiver_as_exact_bytes(self):
        self.run_config("--prepare-receiver")
        source = self.receiver / "check.c"
        source.write_text('#include <stdio.h>\n#include <string.h>\n#include "link_config.h"\n'
                          'int main(void) { fwrite(M5_LINK_WIFI_SSID, 1, strlen(M5_LINK_WIFI_SSID), stdout); '
                          'putchar(0); fwrite(M5_LINK_WIFI_PASSWORD, 1, strlen(M5_LINK_WIFI_PASSWORD), stdout); '
                          'return 0; }\n')
        binary = self.receiver / "check"
        subprocess.run([shutil.which("cc"), "-Wall", "-Wextra", "-Werror", str(source), "-o", str(binary)],
                       check=True, capture_output=True)
        result = subprocess.run([str(binary)], check=True, capture_output=True)
        self.assertEqual(result.stdout, SSID.encode("utf-8") + b"\0" + PASSWORD.encode("ascii"))

    def test_explicit_token_rotation_updates_both_sides(self):
        self.run_config("--prepare-receiver")
        token_file = self.base / "token.txt"
        token_file.write_text(TOKEN + "\n")
        self.run_config("--host", "192.168.2.25", "--token-file", str(token_file), "--port", "9999")
        self.assertEqual(self.state()["token"], TOKEN)
        for path in (self.root / "source/m5_config.h", self.receiver / "link_config.h"):
            self.assertIn(TOKEN, path.read_text())
            self.assertIn("9999u", path.read_text())

    def test_legacy_pc_listener_needs_no_wifi_configuration(self):
        self.wifi_header.unlink()
        self.run_config("--host", "192.168.2.25")
        original_token = self.state()["token"]
        self.run_config("--host", "192.168.2.26")
        self.assertEqual(self.state()["token"], original_token)
        self.assertFalse((self.receiver / "link_config.h").exists())

    def test_invalid_inputs_preserve_all_existing_pairing_files(self):
        self.run_config("--prepare-receiver", "--host", "192.168.2.25")
        expected = self.snapshot()
        token_file = self.base / "token.txt"
        token_file.write_text("invalid\"secret")
        for arguments in (("--host", "8.8.8.8"), ("--host", "192.168.2.25", "--port", "1023"),
                          ("--host", ""), ("--prepare-receiver", "--token-file", str(token_file))):
            with self.subTest(arguments=arguments):
                self.run_config(*arguments, success=False)
                self.assertEqual(self.snapshot(), expected)
        invalid_wifi = (
            '#define WIFI_SSID "plain untrusted"\n#define WIFI_PASSWORD "password"\n',
            wifi.configuration(SSID, PASSWORD) + '#define WIFI_SSID "\\141"\n',
            wifi.configuration(SSID, PASSWORD).replace(wifi.c_literal(SSID), '"\\377"'),
            wifi.configuration(SSID, PASSWORD).replace(wifi.c_literal(SSID), '"\\000"'),
            wifi.configuration(SSID, PASSWORD).replace(wifi.c_literal(SSID), '"' + '\\141' * 33 + '"'),
            wifi.configuration(SSID, PASSWORD).replace(wifi.c_literal(PASSWORD), '"\\141"'),
            wifi.configuration(SSID, PASSWORD).replace(wifi.c_literal(PASSWORD), '"' + '\\001' * 8 + '"'),
        )
        for index, content in enumerate(invalid_wifi):
            with self.subTest(invalid_wifi=index):
                self.wifi_header.write_text(content, encoding="utf-8")
                self.run_config("--prepare-receiver", success=False)
                self.assertEqual(self.snapshot(), expected)

    def test_invalid_saved_state_never_replaces_token_or_echoes_contents(self):
        self.run_config("--prepare-receiver")
        state_file = self.root / ".m5-link.json"
        for content in ('{"token": "private-marker"', '["private-marker"]',
                        '{"token":"private-marker","port":8768}',
                        json.dumps(dict(token=TOKEN, port=True))):
            state_file.write_text(content)
            expected = self.snapshot()
            result = self.run_config("--prepare-receiver", success=False)
            self.assertNotIn("private-marker", result.stdout + result.stderr)
            self.assertEqual(self.snapshot(), expected)

    def test_first_host_configuration_invalidates_optional_include_build(self):
        os.utime(self.wrapper, (946684800, 946684800))
        previous = self.wrapper.stat().st_mtime_ns
        original_contents = self.wrapper.read_bytes()
        self.run_config("--host", "192.168.2.25")
        self.assertGreater(self.wrapper.stat().st_mtime_ns, previous)
        self.assertEqual(self.wrapper.read_bytes(), original_contents)

    def test_missing_wifi_for_prepare_does_not_create_pairing(self):
        self.wifi_header.unlink()
        self.run_config("--prepare-receiver", success=False)
        self.assertFalse((self.root / ".m5-link.json").exists())
        self.assertFalse((self.receiver / "link_config.h").exists())


if __name__ == "__main__":
    unittest.main()
