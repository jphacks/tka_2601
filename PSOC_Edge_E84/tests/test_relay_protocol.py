"""Exercise /api/relay v2 controls and raw PCM without private configuration."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class RelayProtocolTests(unittest.TestCase):
    def test_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "relay_protocol"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
                "-fsanitize=address,undefined", "-I", str(ROOT / "source"),
                str(ROOT / "tests/relay_protocol_harness.c"),
                str(ROOT / "source/relay_protocol.c"),
                str(ROOT / "source/voice_protocol.c"), "-o", str(binary),
            ], check=True)
            subprocess.run([str(binary)], check=True)
