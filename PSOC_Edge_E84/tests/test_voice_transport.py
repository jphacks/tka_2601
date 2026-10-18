"""Exercise actual E84 transport with bounded TLS/socket mocks, no credentials."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class VoiceTransportTests(unittest.TestCase):
    def test_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            # Copy the source so quoted includes select these harmless settings,
            # never the developer's private api_config.h / m5_config.h.
            shutil.copytree(ROOT / "tests/voice_transport_stubs", work, dirs_exist_ok=True)
            for name in ("voice_transport.c", "voice_transport.h", "voice_protocol.c",
                         "voice_protocol.h", "voice_settings.h", "relay_protocol.c", "relay_protocol.h"):
                shutil.copyfile(ROOT / "source" / name, work / name)
            binary = work / "transport_test"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g", "-DVOICE_RELAY_PROTOCOL=2",
                "-fsanitize=address,undefined", "-I", str(work),
                str(ROOT / "tests/voice_transport_harness.c"),
                str(work / "voice_transport.c"), str(work / "voice_protocol.c"), str(work / "relay_protocol.c"),
                "-o", str(binary),
            ], check=True)
            subprocess.run([str(binary)], check=True)
