#include "servo_probe.h"
#include "servo_control.h"
#include "voice_stream.h"
#include "xlog.h"
#include <Arduino.h>
#include <Preferences.h>
#include <cstring>

namespace {
enum Stage : uint8_t { Idle, Armed, Consumed, Requested, Finished, Skipped };
bool pending = false, observing = false;
uint32_t startedAt = 0;
Stage readStage() {
  Preferences db;
  if (!db.begin("p1-bench", true)) return Idle;
  return static_cast<Stage>(db.getUChar("stage", Idle));
}
bool storeStage(Stage stage) {
  Preferences db;
  return db.begin("p1-bench", false) && db.putUChar("stage", stage) == 1 && db.getUChar("stage", 255) == stage;
}
}
void servo_probe_begin() {
  if (readStage() == Armed && storeStage(Consumed)) {
    pending = true;
    startedAt = millis();
  }
}
void servo_probe_poll() {
  if (pending && millis() - startedAt >= 5000u) {
    pending = false;
    if (servo_motion_busy() || voice_stream_busy() || voice_stream_recovery_required() || !storeStage(Requested)) {
      storeStage(Skipped);
      return;
    }
    observing = servo_test('c');
    if (!observing) storeStage(Skipped);
  }
  if (observing && !servo_test_busy()) {
    observing = false;
    storeStage(Finished);  // Driver is idle, no shaft-position sensor.
  }
}
bool servo_probe_command(const char* command) {
  if (std::strcmp(command, "@j2-probe status") == 0) {
    xlog("[J2 PROBE] stage=%u pending=%u observing=%u\n", unsigned(readStage()), pending, observing);
  } else if (std::strcmp(command, "@j2-probe arm") == 0) {
    const bool ok = !pending && !observing && !voice_stream_busy() && !servo_motion_busy() && !voice_stream_recovery_required() && storeStage(Armed);
    xlog("[J2 PROBE] next_boot_armed=%u\n", ok);
  } else return false;
  return true;
}
