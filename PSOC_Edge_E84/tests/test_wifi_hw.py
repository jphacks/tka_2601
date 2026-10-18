"""Guard E84's GPIO/SDIO prerequisites before calling the real WCM API."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WifiHardwareTests(unittest.TestCase):
    def test_initialization_failures_and_retained_irq_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            for deep_sleep in (0, 1):
                binary = Path(directory) / f"wifi_hw_{deep_sleep}"
                subprocess.run([
                    "clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
                    "-fsanitize=address,undefined",
                    f"-DCY_CFG_PWR_SYS_IDLE_MODE={deep_sleep}",
                    "-I", str(ROOT / "tests/wifi_hw_stubs"),
                    "-I", str(ROOT / "source"),
                    str(ROOT / "tests/wifi_hw_harness.c"),
                    str(ROOT / "source/e84_wifi_hw.c"), "-o", str(binary),
                ], check=True)
                for failure in range(9 if deep_sleep else 8):
                    with self.subTest(deep_sleep=deep_sleep, failure=failure):
                        subprocess.run(
                            [str(binary), str(failure)], check=True,
                            env={**os.environ, "ASAN_OPTIONS": "detect_stack_use_after_return=1"},
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                        )
