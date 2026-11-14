"""Exercise CM55 capture/queue/mailbox behavior against the actual DSP code."""
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

ROOT = Path(__file__).parents[1]


class AudioApplicationTests(unittest.TestCase):
    def test_capture_queue_acknowledgement_and_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            (temp / "cy_result.h").write_text(
                "#include <stdint.h>\ntypedef uint32_t cy_rslt_t;\n"
                "#define CY_RSLT_SUCCESS 0u\n#define CY_RSLT_FAILURE 1u\n")
            (temp / "FreeRTOS.h").write_text(
                "#include <stdint.h>\ntypedef uint32_t TickType_t;\n#define pdMS_TO_TICKS(t) (t)\n")
            (temp / "task.h").write_text(
                "void vTaskDelete(void *task);\nTickType_t xTaskGetTickCount(void);\n")
            with wave.open(str(ROOT / "tests/fixtures/reference.wav"), "rb") as source:
                self.assertEqual((source.getframerate(), source.getnchannels(), source.getsampwidth()),
                                 (16000, 1, 2))
                (temp / "reference.pcm").write_bytes(source.readframes(source.getnframes()))
            binary = temp / "test_audio_app"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
                "-fsanitize=address,undefined", "-I", str(temp), "-I", str(ROOT / "source"),
                str(ROOT / "tests/audio_app_harness.c"), str(ROOT / "source/audio_core.c"),
                str(ROOT / "source/audio_reference.c"), str(ROOT / "source/voice_capture.c"),
                "-lm", "-o", str(binary)
            ], check=True)
            subprocess.run([str(binary), str(temp / "reference.pcm")], check=True)
