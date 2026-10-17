"""Run the actual reconnect policy through outages, slow retries and clock wrap."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class WifiReconnectTests(unittest.TestCase):
    def test_outage_recovery_and_retry_spacing(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "test_wifi_reconnect"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-I", str(ROOT / "source"),
                str(ROOT / "tests/wifi_reconnect_harness.c"),
                str(ROOT / "source/wifi_reconnect.c"), "-o", str(binary),
            ], check=True)
            subprocess.run([str(binary)], check=True)
