"""Bounded device framing and RFC6455 upgrade/header validation."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class VoiceProtocolTests(unittest.TestCase):
    def test_framing(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "voice_protocol"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
                "-fsanitize=address,undefined", "-I", str(ROOT / "source"),
                str(ROOT / "tests/voice_protocol_harness.c"),
                str(ROOT / "source/voice_protocol.c"), "-o", str(binary),
            ], check=True)
            subprocess.run([str(binary)], check=True)
