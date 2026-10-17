"""Exercise real capture endpointing and buffer boundaries under sanitizers."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class VoiceCaptureTests(unittest.TestCase):
    def test_endpointing_and_gating(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "voice_capture"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
                "-fsanitize=address,undefined", "-I", str(ROOT / "source"),
                str(ROOT / "tests/voice_capture_harness.c"),
                str(ROOT / "source/voice_capture.c"), "-lm", "-o", str(binary),
            ], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
