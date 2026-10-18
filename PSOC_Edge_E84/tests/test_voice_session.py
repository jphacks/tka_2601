"""Compile the actual CM33 session state machine with deterministic fake peers."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class VoiceSessionTests(unittest.TestCase):
    def test_session_turns_playback_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            # Copy an explicit allowlist so quoted includes cannot resolve any
            # local generated credentials, SDK headers or physical transports.
            for name in (
                "voice_stream.c", "voice_stream.h", "voice_protocol.h", "voice_settings.h",
                "e84_shared.h", "audio_core.h", "e84_network.h", "m5_link.h",
            ):
                shutil.copyfile(ROOT / "source" / name, temp / name)
            shutil.copyfile(ROOT / "tests/voice_session_harness.c", temp / "harness.c")
            (temp / "m5_settings.h").write_text('#define M5_TOKEN "unit-test-token"\n')
            (temp / "cy_wcm.h").write_text("/* Hardware deliberately absent. */\n")
            (temp / "voice_transport.h").write_text('''#pragma once
#include "voice_protocol.h"
typedef uint32_t TickType_t;
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
TickType_t xTaskGetTickCount(void);
void vTaskDelay(TickType_t ticks);
typedef struct { bool websocket, legacy, diagnostic; } voice_transport_t;
static inline bool voice_transport_legacy(const voice_transport_t *link) { return link->websocket && link->legacy; }
typedef struct { voice_header_t header; uint8_t payload[VOICE_PAYLOAD]; } voice_packet_t;
void voice_transport_init(voice_transport_t *link);
bool voice_transport_server(voice_transport_t *link);
bool voice_transport_m5(voice_transport_t *link);
void voice_transport_close(voice_transport_t *link);
bool voice_transport_send(voice_transport_t *link, const voice_header_t *header, const void *payload);
int voice_transport_poll(voice_transport_t *link, voice_packet_t *packet);
''')
            binary = temp / "session"
            subprocess.run([
                "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
                "-fsanitize=address,undefined", "-I", str(temp),
                str(temp / "harness.c"), "-o", str(binary),
            ], check=True)
            result=subprocess.run([str(binary)], check=True, capture_output=True, text=True)
            self.assertIn('Call ending: reason=manual_stop',result.stdout)
            self.assertIn('Call ending: reason=m5_probe_failed',result.stdout)
            print(result.stdout,end='')


if __name__ == "__main__":
    unittest.main()
