#include "console.h"
#include "net_task.h"
#include "servo_control.h"
#include "servo_probe.h"
#include "tune.h"
#include "voice_stream.h"
#include "voice_call_diag.h"
#include "field_timing.h"
#include "xlog.h"
extern "C" {
#include "audio_app.h"
#include "audio_link.h"
}
#include <Arduino.h>
#include <stdarg.h>
#include <string.h>

namespace {
char line[80];
size_t used = 0;
bool overflow = false;

void help() {
  xlog("[HELP] c=start call; q=end call; s=status; e=register chime; x=cancel registration/servo test; r=record 5s\n");
  xlog("[HELP] 1/2/3=physical pusher test 1/2/unlock; t=speaker tone; l=mic loopback; m=mic level; n=Wi-Fi; a=API HTTPS; w=API WSS; u=USB\n");
  xlog("[HELP] @get @begin @set c|e|u r|p 0..180 @angles @time @save @cancel @test @stop @mirror e @net @tune @pusher 0 mask start end @confirm\n");
  xlog("[HELP] @pusher is local wiring setup only, before cloud provisioning; cloud revisions are server-owned.\n");
  xlog("[HELP] @voice-call status: last call numeric end reason/timing; no audio or credentials stored.\n");
  xlog("[HELP] FORMAT_AUDIO_STORAGE erases the audio_store partition (registered chime and recordings).\n");
}
void micStatus() {
  volatile audio_link_t* s = audio_link();
  audio_link_acquire();
  xlog("[DIAG] mic {\"status\":%lu,\"rms\":%.1f,\"pcm_min\":%ld,\"pcm_max\":%ld,\"errors\":%lu,\"detected\":%lu,\"last_score\":%.3f,\"model\":%s,\"threshold\":%.3f,\"gate\":%.1f,\"storage\":%s}\n",
    (unsigned long)s->audio_status, (double)s->last_rms, (long)s->pcm_min, (long)s->pcm_max,
    (unsigned long)s->capture_errors, (unsigned long)s->detected_count, (double)s->last_score,
    audio_app_model_valid() ? "true" : "false", (double)audio_app_threshold(), (double)audio_app_gate(),
    audio_storage_ready() ? "true" : "false");
}
void execute(const char* text) {
  if (text[0] == '@') {
    if (!strcmp(text, "@last-timing")) { field_timing_print(); return; }
    if (voice_call_diag_command(text)) return;
    if (servo_probe_command(text)) return;
    if (!strcmp(text, "@net")) net_report_calibration();
    else if (!strncmp(text, "@tune ", 6)) tune_command(text);
    else {
      servo_calibration_command(text);
      if (!strcmp(text, "@confirm") && !servo_recovery_required()) voice_stream_confirm_recovery();
    }
    return;
  }
  if (!strcmp(text, "FORMAT_AUDIO_STORAGE")) { audio_app_post_command('F'); return; }
  if (!text[0] || text[1]) return;
  switch (text[0]) {
    case 'h': help(); break;
    case 's':
      xlog("[STATE] busy=%u recovery=%u uptime_ms=%lu\n", voice_stream_busy() ? 1u : 0u, voice_stream_recovery_required() ? 1u : 0u, (unsigned long)millis());
      audio_app_post_command('s'); servo_log_status(); net_report_wifi();
      break;
    case 'e': case 'r': audio_app_post_command(text[0]); break;
    case 'x': audio_app_post_command('x'); servo_test_cancel(); break;
    case 'c':
      if (voice_stream_busy()) xlog("[VOICE] Call already active or recovery required.\n");
      else voice_stream_request_call();
      break;
    case 'q': voice_stream_request_stop(); break;
    case '1': servo_test('c'); break;
    case '2': servo_test('e'); break;
    case '3': servo_test('u'); break;
    case 't': voice_stream_request_speaker_test(); break;
    case 'l': voice_stream_request_loopback(); break;
    case 'm': micStatus(); break;
    case 'n': net_report_wifi(); break;
    case 'a': net_request_api_probe(); break;
    case 'w':
      if (voice_stream_busy()) xlog("[API WSS] busy\n");
      else voice_stream_request_api_probe();
      break;
    case 'u': xlog("[DIAG] usb ok=1\n"); break;
    default: break;
  }
}
}

extern "C" void xlog(const char* format, ...) {
  // A full calibration reply is about 800 bytes.
  char text[1400];
  va_list arguments;
  va_start(arguments, format);
  const int length = vsnprintf(text, sizeof(text), format, arguments);
  va_end(arguments);
  if (length <= 0) return;
  Serial.write(reinterpret_cast<const uint8_t*>(text), length < static_cast<int>(sizeof(text)) ? length : sizeof(text) - 1);
}

void console_begin(void) { help(); }
void console_poll(void) {
  // Bounded so a long paste cannot delay the servo timers in the same loop.
  for (unsigned i = 0; i < 64 && Serial.available(); ++i) {
    const int value = Serial.read();
    if (value == '\n' || value == '\r') {
      line[used] = 0;
      if (!overflow && used) execute(line);
      used = 0; overflow = false;
    } else if (used < sizeof(line) - 1) line[used++] = static_cast<char>(value);
    else overflow = true;
  }
}
