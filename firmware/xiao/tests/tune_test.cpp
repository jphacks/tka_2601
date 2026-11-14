#include "tune.h"
#include <Arduino.h>
#include <Preferences.h>
#include <cassert>
#include <cstdarg>
extern "C" void xlog(const char* format, ...) {
  char text[400];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(text, sizeof(text), format, arguments);
  va_end(arguments);
  fake::serialLines.emplace_back(text);
}
static bool tune(const char* text, const char* contains = nullptr) {
  tune_command(text);
  const std::string& reply = fake::serialLines.back();
  assert(reply.find("[CAL] ") == 0 && reply.find("\"diagnostic\":\"tune\"") != std::string::npos);
  if (contains) assert(reply.find(contains) != std::string::npos);
  return reply.find("\"ok\":true") != std::string::npos;
}
int main() {
  tune_begin();
  assert(tune("@tune get", "\"speaker_volume\":70,\"voice_rms_gate\":600,\"chime_margin\":100"));
  for (const char* bad : {"@tune volume -1", "@tune volume 101", "@tune gate 29", "@tune gate 32768", "@tune margin 49",
                          "@tune margin 201", "@tune other 5", "@tune volume", "@tune volume 5 trailing"})
    assert(!tune(bad, "invalid_tune"));
  assert(fake::storedCalibration.empty());
  assert(tune("@tune volume 35", "\"speaker_volume\":35"));
  assert(tune("@tune gate 450", "\"voice_rms_gate\":450"));
  assert(tune("@tune margin 120", "\"chime_margin\":120"));
  assert(tune_speaker_volume() == 35 && tune_voice_gate() == 450 && tune_chime_margin() == 120);
  fake::failStorage = true;
  assert(!tune("@tune volume 90", "storage_unavailable"));
  assert(tune_speaker_volume() == 35);
  fake::failStorage = false;
  // Survives a reload, and a corrupt record falls back to what is in RAM.
  tune_begin();
  assert(tune_voice_gate() == 450);
  fake::storedCalibration[2] = 0xff; fake::storedCalibration[3] = 0xff;
  tune_begin();
  assert(tune_voice_gate() == 450);
  puts("tune: bounds, persistence and storage failure passed");
}
