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
// Physical servo for this boot's probe: 'c' = J2 (GPIO7), 'e' = J3 (GPIO8).
char target = 'c';
Stage readStage() {
  Preferences db;
  if (!db.begin("p1-bench", true)) return Idle;
  return static_cast<Stage>(db.getUChar("stage", Idle));
}
// A reservation made before the J3 probe existed has no target key; it meant J2.
char readTarget() {
  Preferences db;
  if (!db.begin("p1-bench", true)) return 0;
  return static_cast<char>(db.getUChar("target", 'c'));
}
bool storeStage(Stage stage) {
  Preferences db;
  return db.begin("p1-bench", false) && db.putUChar("stage", stage) == 1 && db.getUChar("stage", 255) == stage;
}
bool storeTarget(char letter) {
  Preferences db;
  const uint8_t value = static_cast<uint8_t>(letter);
  return db.begin("p1-bench", false) && db.putUChar("target", value) == 1 && db.getUChar("target", 0) == value;
}
const char* labelFor(char letter) { return letter == 'e' ? "J3" : "J2"; }
// The target is written before the stage, so an armed stage never pairs with a half-written target.
bool arm(char letter) {
  return !pending && !observing && !voice_stream_busy() && !servo_motion_busy() &&
    !voice_stream_recovery_required() && storeTarget(letter) && storeStage(Armed);
}
}
void servo_probe_begin() {
  if (readStage() == Armed && storeStage(Consumed)) {
    target = readTarget();
    pending = true;
    startedAt = millis();
  }
}
void servo_probe_poll() {
  if (pending && millis() - startedAt >= 5000u) {
    pending = false;
    const bool knownTarget = target == 'c' || target == 'e';
    if (!knownTarget || servo_motion_busy() || voice_stream_busy() || voice_stream_recovery_required() || !storeStage(Requested)) {
      storeStage(Skipped);
      return;
    }
    observing = servo_test(target);
    if (!observing) storeStage(Skipped);
  }
  if (observing && !servo_test_busy()) {
    observing = false;
    storeStage(Finished);  // Driver is idle, no shaft-position sensor.
  }
}
bool servo_probe_command(const char* command) {
  char letter;
  if (!std::strncmp(command, "@j2-probe ", 10)) letter = 'c';
  else if (!std::strncmp(command, "@j3-probe ", 10)) letter = 'e';
  else return false;
  const char* action = command + 10;
  if (!std::strcmp(action, "status")) {
    const char stored = readTarget();
    xlog("[%s PROBE] stage=%u target=%s pending=%u observing=%u\n", labelFor(letter), unsigned(readStage()),
      stored == 'c' || stored == 'e' ? labelFor(stored) : "unknown", pending, observing);
  } else if (!std::strcmp(action, "arm")) {
    xlog("[%s PROBE] next_boot_armed=%u\n", labelFor(letter), arm(letter));
  } else return false;
  return true;
}
