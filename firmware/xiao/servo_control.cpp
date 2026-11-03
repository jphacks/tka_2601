#include "servo_control.h"
#include "board_pins.h"
#include "servo_pwm.h"
#include "xlog.h"
#include <Arduino.h>
#include <Preferences.h>
#include <mutex>
#include <stdio.h>
#include <string.h>

#if __has_include("servo_config.h")
#include "servo_config.h"
#else
#include "servo_config.example.h"
#endif

namespace {
std::recursive_mutex servoLock;
using Guard = std::lock_guard<std::recursive_mutex>;
const char* status = "Servo idle";
enum class Target : uint8_t { Call, End, Unlock };
enum class ServoPhase { Idle, Wait, Press, Return, Calibrating };
ServoPhase servoPhase = ServoPhase::Idle;
Target activeTarget = Target::Call;
bool servoAttached = false;
bool servoTesting = false, servoTestCancelled = false, servoPreview = false;
const char* motionError = "";
bool callOwned = false, callAttempted = false, endAttempted = false;
bool callActionRequested = false, cancelRequested = false, callDone = false, endDone = false, callFailed = false;
uint32_t servoAt = 0;
struct Calibration {
  uint16_t version, callRest, callPress, endRest, endPress, unlockRest, unlockPress;
  uint16_t callDelayMs, callPressMs, endPressMs, unlockPressMs, returnMs;
};
constexpr uint16_t physical(unsigned angle, bool reversed) { return static_cast<uint16_t>(reversed ? 180u - angle : angle); }
Calibration angles = {1,
  physical(XIAO_SERVO_REST_DEG, XIAO_SERVO_CALL_REVERSED),
  physical(XIAO_SERVO_CALL_PRESS_DEG, XIAO_SERVO_CALL_REVERSED),
  physical(XIAO_SERVO_REST_DEG, XIAO_SERVO_END_REVERSED),
  physical(XIAO_SERVO_END_PRESS_DEG, XIAO_SERVO_END_REVERSED),
  physical(XIAO_SERVO_REST_DEG, XIAO_SERVO_UNLOCK_REVERSED),
  physical(XIAO_SERVO_UNLOCK_PRESS_DEG, XIAO_SERVO_UNLOCK_REVERSED),
  3000, XIAO_SERVO_PRESS_MS, XIAO_SERVO_PRESS_MS, XIAO_SERVO_PRESS_MS, XIAO_SERVO_RETURN_MS};
Calibration savedAngles = angles;
bool calibrationStored = false;
struct ServoMotion { uint16_t press, rest, holdMs, returnMs; };
ServoMotion motion{};
int commandedAngle = -1;
const char* motionSource = "none";
bool calibrating = false;
uint32_t calibrationAt = 0;
uint32_t calibrationPreviewMs = 1500;

uint8_t pinFor(Target target) {
  return target == Target::Call ? PIN_SERVO_CALL : target == Target::End ? PIN_SERVO_END : PIN_SERVO_UNLOCK;
}
const char* nameFor(Target target) {
  return target == Target::Call ? "CALL" : target == Target::End ? "END" : "UNLOCK";
}
const char* wordFor(Target target) {
  return target == Target::Call ? "call" : target == Target::End ? "end" : "unlock";
}
bool targetFrom(char letter, Target& target) {
  if (letter == 'c') target = Target::Call;
  else if (letter == 'e') target = Target::End;
  else if (letter == 'u') target = Target::Unlock;
  else return false;
  return true;
}
const char* settingsSource() { return calibrating ? "editing" : calibrationStored ? "saved" : "defaults"; }
void captureMotion(Target target) {
  if (target == Target::Call) motion = {angles.callPress, angles.callRest, angles.callPressMs, angles.returnMs};
  else if (target == Target::End) motion = {angles.endPress, angles.endRest, angles.endPressMs, angles.returnMs};
  else motion = {angles.unlockPress, angles.unlockRest, angles.unlockPressMs, angles.returnMs};
  motionSource = settingsSource();
}
bool validAngles(const Calibration& a) {
  return a.version == 1 && a.callRest <= 180 && a.callPress <= 180 &&
         a.endRest <= 180 && a.endPress <= 180 && a.unlockRest <= 180 && a.unlockPress <= 180 &&
         a.callDelayMs <= 30000 &&
         a.callPressMs >= 100 && a.callPressMs <= 2000 &&
         a.endPressMs >= 100 && a.endPressMs <= 2000 &&
         a.unlockPressMs >= 100 && a.unlockPressMs <= 2000 &&
         a.returnMs >= 100 && a.returnMs <= 3000;
}
void loadCalibration() {
  Preferences prefs;
  if (!prefs.begin("monban-servo", true)) return;
  Calibration stored{};
  calibrationStored = false;
  if (prefs.getBytesLength("settings") == sizeof(stored) &&
      prefs.getBytes("settings", &stored, sizeof(stored)) == sizeof(stored) && validAngles(stored))
    { angles = savedAngles = stored; calibrationStored = true; }
  prefs.end();
}
void calibrationReply(const char* error = nullptr) {
  xlog("[CAL] {\"ok\":%s,\"error\":\"%s\",\"active\":%s,\"call_rest\":%u,\"call_press\":%u,\"end_rest\":%u,\"end_press\":%u,\"unlock_rest\":%u,\"unlock_press\":%u,\"call_delay_ms\":%u,\"call_hold_ms\":%u,\"end_hold_ms\":%u,\"unlock_hold_ms\":%u,\"return_ms\":%u,\"test_busy\":%s,\"test_target\":\"%s\",\"end_mirror_supported\":true,\"settings_source\":\"%s\",\"saved\":{\"call_rest\":%u,\"call_press\":%u,\"end_rest\":%u,\"end_press\":%u,\"unlock_rest\":%u,\"unlock_press\":%u,\"call_delay_ms\":%u,\"call_hold_ms\":%u,\"end_hold_ms\":%u,\"unlock_hold_ms\":%u,\"return_ms\":%u},\"pwm_active\":%s,\"commanded_angle\":%d,\"motion_busy\":%s,\"motion_error\":\"%s\",\"pwm_backend\":\"isolated-ledc\"}\n",
    error ? "false" : "true", error ? error : "", calibrating ? "true" : "false",
    angles.callRest, angles.callPress, angles.endRest, angles.endPress, angles.unlockRest, angles.unlockPress,
    angles.callDelayMs, angles.callPressMs, angles.endPressMs, angles.unlockPressMs, angles.returnMs,
    servoTesting ? "true" : "false",
    servoTesting ? (activeTarget == Target::Call ? "c" : activeTarget == Target::End ? "e" : "u") : "", settingsSource(),
    savedAngles.callRest, savedAngles.callPress, savedAngles.endRest, savedAngles.endPress,
    savedAngles.unlockRest, savedAngles.unlockPress,
    savedAngles.callDelayMs, savedAngles.callPressMs, savedAngles.endPressMs, savedAngles.unlockPressMs, savedAngles.returnMs,
    servoAttached ? "true" : "false", commandedAngle,
    servoPhase != ServoPhase::Idle ? "true" : "false", motionError);
}

uint32_t servoDuty(unsigned angle) {
  const uint32_t pulse = XIAO_SERVO_MIN_US +
    static_cast<uint32_t>(XIAO_SERVO_MAX_US - XIAO_SERVO_MIN_US) * angle / 180u;
  return pulse * monban_servo::kDutySteps / 20000u;
}

bool elapsed(uint32_t now, uint32_t then, uint32_t period) {
  return static_cast<uint32_t>(now - then) >= period;
}
void setStatus(const char* value) {
  status = value;
  xlog("[STREAM] %s\n", value);
}
void logServoConfiguration() {
  xlog("[SERVO] Active source=%s CALL: GPIO=%d press=%u rest=%u; END: GPIO=%d press=%u rest=%u; UNLOCK: GPIO=%d press=%u rest=%u\n",
    settingsSource(), PIN_SERVO_CALL, angles.callPress, angles.callRest,
    PIN_SERVO_END, angles.endPress, angles.endRest, PIN_SERVO_UNLOCK, angles.unlockPress, angles.unlockRest);
  xlog("[SERVO] Settings PWM=50Hz range_us=%d..%d press_ms=%d return_ms=%d\n",
    XIAO_SERVO_MIN_US, XIAO_SERVO_MAX_US, angles.callPressMs, angles.returnMs);
  xlog("[SERVO] Saved CALL wait=%u ms hold=%u ms; END hold=%u ms; UNLOCK hold=%u ms; return=%u ms\n",
    angles.callDelayMs, angles.callPressMs, angles.endPressMs, angles.unlockPressMs, angles.returnMs);
}
bool servoConfigValid() {
  return (XIAO_SERVO_CALL_REVERSED == 0 || XIAO_SERVO_CALL_REVERSED == 1) &&
    (XIAO_SERVO_END_REVERSED == 0 || XIAO_SERVO_END_REVERSED == 1) &&
    (XIAO_SERVO_UNLOCK_REVERSED == 0 || XIAO_SERVO_UNLOCK_REVERSED == 1) &&
    XIAO_SERVO_MIN_US >= 500 && XIAO_SERVO_MIN_US < XIAO_SERVO_MAX_US && XIAO_SERVO_MAX_US <= 2500 &&
    XIAO_SERVO_REST_DEG >= 0 && XIAO_SERVO_REST_DEG <= 180 &&
    XIAO_SERVO_CALL_PRESS_DEG >= 0 && XIAO_SERVO_CALL_PRESS_DEG <= 180 &&
    XIAO_SERVO_END_PRESS_DEG >= 0 && XIAO_SERVO_END_PRESS_DEG <= 180 &&
    XIAO_SERVO_UNLOCK_PRESS_DEG >= 0 && XIAO_SERVO_UNLOCK_PRESS_DEG <= 180 &&
    XIAO_SERVO_PRESS_MS >= 100 && XIAO_SERVO_PRESS_MS <= 2000 &&
    XIAO_SERVO_RETURN_MS >= 100 && XIAO_SERVO_RETURN_MS <= 3000;
}
void servoFailure(const char* reason) {
  motionError = reason;
  servoAttached = false; servoPhase = ServoPhase::Idle;
  setStatus(reason);
  if (servoTesting || servoPreview) {
    // A failed local motion must release the UI's busy state, without using
    // old call flags to schedule another button operation.
    servoTesting = servoPreview = false;
  } else if (callOwned) callFailed = true;
}
void neutralServo() {
  // Returning is idempotent: save/cancel cannot rewrite the target or restart
  // its timer while the same return operation is already running.
  if (servoPhase == ServoPhase::Return) return;
  if (servoAttached) {
    if (!monban_servo::write(pinFor(activeTarget), servoDuty(motion.rest))) {
      monban_servo::detach(pinFor(activeTarget));
      servoFailure("servo_return_failed"); return;
    }
    commandedAngle = motion.rest;
    servoPhase = ServoPhase::Return; servoAt = millis();
    xlog("[SERVO] %s returning to %u degrees for %u ms; at_ms=%lu\n",
      nameFor(activeTarget), motion.rest, motion.returnMs, (unsigned long)servoAt);
  } else servoPhase = ServoPhase::Idle;
}
bool attachAndPressServo(Target target) {
  motionError = "";
  activeTarget = target;
  servoAttached = monban_servo::attach(pinFor(target));
  if (!servoAttached) return false;
  captureMotion(target);
  const unsigned pressAngle = motion.press;
  if (!monban_servo::write(pinFor(target), servoDuty(pressAngle))) return false;
  commandedAngle = pressAngle;
  servoPhase = ServoPhase::Press;
  servoAt = millis();
  xlog("[SERVO] %s press once: %u degrees for %u ms; source=%s rest=%u pulse_us=%u at_ms=%lu\n",
    nameFor(target), pressAngle, motion.holdMs, motionSource, motion.rest,
    XIAO_SERVO_MIN_US + (XIAO_SERVO_MAX_US-XIAO_SERVO_MIN_US)*pressAngle/180u, (unsigned long)servoAt);
  return true;
}
bool beginPhysicalServo() {
  if (!servoTesting) {
    if (activeTarget == Target::End) endAttempted = true;
    else callAttempted = true; // even a partial PWM failure may have moved it
  }
  return attachAndPressServo(activeTarget);
}
void startPressFailed() {
  // A partial attach still returns and detaches the selected servo.
  if (servoAttached) neutralServo();
  if (servoPhase != ServoPhase::Return) {
    if (servoAttached) monban_servo::detach(pinFor(activeTarget));
    servoFailure("servo_pwm_failed");
  } else callFailed = true;
}
bool startServo(Target target) {
  if (servoPhase != ServoPhase::Idle) { callFailed = true; setStatus("servo_busy"); return false; }
  if (!servoConfigValid()) { callFailed = true; setStatus("servo_config_invalid"); return false; }
  motionError = "";
  if (target == Target::Call) callActionRequested = true;
  activeTarget = target; servoAt = millis();
  if (target == Target::Call && angles.callDelayMs) {
    servoPhase = ServoPhase::Wait;
    setStatus("Waiting before one call-button press");
    xlog("[SERVO] CALL waiting %u ms; no button pressed yet\n", angles.callDelayMs);
    return true;
  }
  if (!beginPhysicalServo()) { startPressFailed(); return false; }
  setStatus(target == Target::End ? "Pressing end button" : "Pressing call button");
  return true;
}
void testStatus(const char* cancelled, const char* complete) {
  static char text[48];
  snprintf(text, sizeof(text), "Servo test %s: %s", servoTestCancelled ? cancelled : complete, wordFor(activeTarget));
  setStatus(text);
}
void completeServo() {
  servoPhase = ServoPhase::Idle;
  if (servoPreview) {
    servoPreview = false;
    static char text[48];
    snprintf(text, sizeof(text), "Calibration preview complete: %s", wordFor(activeTarget));
    setStatus(text);
    return;
  }
  if (servoTesting) {
    servoTesting = false;
    testStatus("cancelled", "complete");
    return;
  }
  if (!callOwned) return;
  if (cancelRequested && activeTarget == Target::Call) {
    // The call servo has returned; now end the possibly active intercom call.
    startServo(Target::End);
    return;
  }
  if (activeTarget == Target::End) { endDone = true; setStatus("Call ended"); }
  else { callDone = true; setStatus("Call started"); }
}
void pollServo() {
  if (calibrating && elapsed(millis(), calibrationAt, 120000)) {
    calibrating = false; angles = savedAngles; neutralServo();
    setStatus("Calibration timed out; unsaved angles discarded");
  } else if (servoPhase == ServoPhase::Calibrating && elapsed(millis(), servoAt, calibrationPreviewMs)) {
    neutralServo();
  }
  if (servoPhase == ServoPhase::Wait && elapsed(millis(), servoAt, angles.callDelayMs)) {
    if (!beginPhysicalServo()) {
      if (servoTesting) {
        servoTestCancelled = true;
        neutralServo();
        if (servoPhase == ServoPhase::Idle) servoTesting = false; // nothing moved: calls must not stay blocked
      } else startPressFailed();
    } else setStatus("Pressing call button once");
  } else if (servoPhase == ServoPhase::Press && elapsed(millis(), servoAt, motion.holdMs)) {
    neutralServo();
  } else if (servoPhase == ServoPhase::Return && elapsed(millis(), servoAt, motion.returnMs)) {
    const bool stopped = monban_servo::detach(pinFor(activeTarget));
    servoAttached = false;
    if (!stopped) { servoFailure("servo_release_failed"); return; }
    xlog("[SERVO] %s released; PWM stopped; signal LOW; at_ms=%lu\n", nameFor(activeTarget), (unsigned long)millis());
    completeServo();
  }
}
bool requestServoTest(Target target, bool useCalibration) {
  if ((calibrating && !useCalibration) || callOwned || servoTesting || servoPhase != ServoPhase::Idle) {
    xlog("[STREAM] Servo test refused: servo busy\n");
    return false;
  }
  if (!servoConfigValid()) {
    setStatus("Servo test refused: physical servo configuration required");
    return false;
  }
  // Do not touch callAttempted/endAttempted. A local diagnostic must never
  // schedule the call's other servo.
  motionError = "";
  servoTesting = true; servoTestCancelled = false;
  activeTarget = target; servoAt = millis();
  if (target == Target::Call && angles.callDelayMs) {
    servoPhase = ServoPhase::Wait;
    setStatus("Servo test waiting before one call press");
    return true;
  }
  if (!attachAndPressServo(target)) {
    servoTestCancelled = true;
    neutralServo();
    if (servoPhase == ServoPhase::Idle) servoTesting = false;
    setStatus("Servo test failed: PWM unavailable");
    return false;
  }
  static char text[48];
  snprintf(text, sizeof(text), "Servo test pressing: %s", wordFor(target));
  setStatus(text);
  return true;
}
bool cancelServoTest() {
  if (!servoTesting) return false;
  servoTestCancelled = true;
  // Repeated cancel must not keep extending the return interval.
  if (servoPhase == ServoPhase::Wait) { servoPhase = ServoPhase::Idle; servoTesting = false; }
  else if (servoPhase == ServoPhase::Press) neutralServo();
  static char text[48];
  snprintf(text, sizeof(text), "Servo test returning: %s", wordFor(activeTarget));
  setStatus(text);
  return true;
}
}  // namespace

extern "C" {
void servo_begin(void) {
  Guard guard(servoLock);
  loadCalibration();
  monban_servo::idle(PIN_SERVO_CALL);
  monban_servo::idle(PIN_SERVO_END);
  monban_servo::idle(PIN_SERVO_UNLOCK);
  logServoConfiguration();
}
void servo_poll(void) {
  Guard guard(servoLock);
  pollServo();
}
bool servo_call_open(void) {
  Guard guard(servoLock);
  if (calibrating || callOwned || servoTesting || servoPhase != ServoPhase::Idle) return false;
  callOwned = true;
  callAttempted = endAttempted = callActionRequested = cancelRequested = false;
  callDone = endDone = callFailed = false;
  return true;
}
bool servo_call_press(void) {
  Guard guard(servoLock);
  if (!callOwned || callActionRequested) return callOwned;
  return startServo(Target::Call);
}
bool servo_end_press(void) {
  Guard guard(servoLock);
  if (!callOwned) return false;
  if (endAttempted) return true; // END only once, even if requested again
  return startServo(Target::End);
}
void servo_call_cancel(void) {
  Guard guard(servoLock);
  if (!callOwned || cancelRequested) return; // do not restart a pending physical operation
  cancelRequested = true;
  if (endAttempted) return; // END finished or is running; its own result stands
  if (servoPhase == ServoPhase::Wait && !callAttempted) {
    servoPhase = ServoPhase::Idle; callActionRequested = false;
    endDone = true;
    setStatus("Cancelled during wait; no button pressed");
    return;
  }
  if (servoPhase == ServoPhase::Press || servoPhase == ServoPhase::Return) {
    neutralServo(); // completeServo schedules END after the call servo returns
    return;
  }
  servoPhase = ServoPhase::Idle;
  callFailed = false; // the earlier failure is what this cancel is handling
  if (callActionRequested) startServo(Target::End);
  else { endDone = true; setStatus("Cancelled before call start"); }
}
servo_call_status_t servo_call_status(void) {
  Guard guard(servoLock);
  if (endDone) return SERVO_CALL_ENDED;
  if (callFailed) return SERVO_CALL_FAILED;
  if (callDone && !cancelRequested && !endAttempted) return SERVO_CALL_STARTED;
  return SERVO_CALL_PENDING;
}
void servo_call_close(void) {
  Guard guard(servoLock);
  callOwned = false;
  // Uncertain outcome: never leave a press output latched.
  if (servoPhase == ServoPhase::Press) neutralServo();
  else if (servoPhase == ServoPhase::Wait) servoPhase = ServoPhase::Idle;
}
bool servo_test(char letter) {
  Guard guard(servoLock);
  Target target;
  return targetFrom(letter, target) && requestServoTest(target, false);
}
bool servo_test_cancel(void) { Guard guard(servoLock); return cancelServoTest(); }
bool servo_test_busy(void) { Guard guard(servoLock); return servoTesting; }
bool servo_motion_busy(void) { Guard guard(servoLock); return servoAttached || servoPhase == ServoPhase::Wait; }
bool servo_calibration_active(void) { Guard guard(servoLock); return calibrating; }
const char *servo_status(void) { Guard guard(servoLock); return status; }
void servo_log_status(void) {
  Guard guard(servoLock);
  xlog("[STREAM] call_owned=%u status=%s\n", callOwned, status);
  logServoConfiguration();
  calibrationReply();
}
void servo_calibration_command(const char* command) {
  Guard guard(servoLock);
  if (!strcmp(command, "@get")) { calibrationReply(); return; }
  if (!strcmp(command, "@stop")) {
    if (!cancelServoTest()) { calibrationReply("test_not_running"); return; }
    calibrationReply(); return;
  }
  if (!strcmp(command, "@test c") || !strcmp(command, "@test e") || !strcmp(command, "@test u")) {
    Target testTarget = Target::Call;
    targetFrom(command[6], testTarget);
    if (!requestServoTest(testTarget, true)) { calibrationReply("receiver_busy"); return; }
    if (calibrating) calibrationAt = millis();
    calibrationReply(); return;
  }
  if (servoTesting) { calibrationReply("servo_test_busy"); return; }
  if (!strcmp(command, "@begin")) {
    if (calibrating) { calibrationAt = millis(); calibrationReply(); return; }
    if (callOwned || servoTesting || servoPhase != ServoPhase::Idle) {
      calibrationReply("receiver_busy"); return;
    }
    if (!servoConfigValid()) {
      calibrationReply("servo_configuration_required"); return;
    }
    savedAngles = angles; calibrating = true; calibrationAt = millis();
    setStatus("USB angle calibration; calls paused"); calibrationReply(); return;
  }
  if (!calibrating) { calibrationReply("begin_required"); return; }
  calibrationAt = millis();
  if (!strcmp(command, "@cancel")) {
    angles = savedAngles; calibrating = false; neutralServo();
    setStatus("Calibration cancelled"); calibrationReply(); return;
  }
  if (!strcmp(command, "@save")) {
    Preferences prefs;
    if (!prefs.begin("monban-servo", false)) { calibrationReply("storage_unavailable"); return; }
    Calibration verified{};
    const bool written = prefs.putBytes("settings", &angles, sizeof(angles)) == sizeof(angles) &&
      prefs.getBytes("settings", &verified, sizeof(verified)) == sizeof(verified) &&
      !memcmp(&verified, &angles, sizeof(angles));
    prefs.end();
    if (!written) { calibrationReply("save_failed"); return; }
    savedAngles = angles; calibrationStored = true; calibrating = false; neutralServo();
    setStatus("Servo angles saved"); calibrationReply(); return;
  }
  char letter = 0, position = 0, extra = 0; int angle = -1;
  Target target = Target::Call;
  if (!strcmp(command, "@mirror e")) {
    if (servoPhase != ServoPhase::Idle || servoAttached) { calibrationReply("servo_busy"); return; }
    // Saved angles are PWM command angles. Mirror both endpoints only once,
    // without changing CALL, timings, PWM output, or the persistent record.
    angles.endRest = physical(angles.endRest, true);
    angles.endPress = physical(angles.endPress, true);
    setStatus("END angles mirrored; no motion (unsaved)");
    calibrationReply(); return;
  }
  if (!strncmp(command, "@angles ", 8)) {
    int rest = -1, press = -1;
    if (sscanf(command, "@angles %c %d %d %c", &letter, &rest, &press, &extra) != 3 ||
        !targetFrom(letter, target) || rest < 0 || rest > 180 || press < 0 || press > 180) {
      calibrationReply("invalid_angles"); return;
    }
    if (servoPhase != ServoPhase::Idle || servoAttached) { calibrationReply("servo_busy"); return; }
    // Restore editor values after an update without previewing or moving.
    if (target == Target::End) { angles.endRest = rest; angles.endPress = press; }
    else if (target == Target::Unlock) { angles.unlockRest = rest; angles.unlockPress = press; }
    else { angles.callRest = rest; angles.callPress = press; }
    calibrationReply(); return;
  }
  if (!strncmp(command, "@time ", 6)) {
    int ms = -1;
    if (sscanf(command, "@time %c %d %c", &letter, &ms, &extra) != 2 ||
        (letter != 'd' && letter != 'c' && letter != 'e' && letter != 'u' && letter != 'r') ||
        ms < (letter == 'd' ? 0 : 100) ||
        ms > (letter == 'd' ? 30000 : letter == 'r' ? 3000 : 2000)) {
      calibrationReply("invalid_timing"); return;
    }
    if (servoPhase != ServoPhase::Idle) { calibrationReply("servo_busy"); return; }
    uint16_t& value = letter == 'd' ? angles.callDelayMs : letter == 'c' ? angles.callPressMs :
      letter == 'e' ? angles.endPressMs : letter == 'u' ? angles.unlockPressMs : angles.returnMs;
    value = static_cast<uint16_t>(ms); calibrationReply(); return;
  }
  if (sscanf(command, "@set %c %c %d %c", &letter, &position, &angle, &extra) != 3 ||
      !targetFrom(letter, target) || (position != 'r' && position != 'p') || angle < 0 || angle > 180) {
    calibrationReply("invalid_command"); return;
  }
  const uint8_t pin = pinFor(target);
  // Finish returning the previous servo before switching to the other one.
  if (servoAttached && activeTarget != target) {
    if (servoPhase != ServoPhase::Return) neutralServo();
    calibrationReply("returning_previous_servo"); return;
  }
  if (servoPhase != ServoPhase::Idle) { calibrationReply("servo_busy"); return; }
  motionError = "";
  activeTarget = target;
  if (!servoAttached) servoAttached = monban_servo::attach(pin);
  if (!servoAttached) { calibrationReply("pwm_unavailable"); return; }
  if (!monban_servo::write(pin, servoDuty(static_cast<unsigned>(angle)))) {
    captureMotion(target);
    neutralServo(); calibrationReply("pwm_write_failed"); return;
  }
  commandedAngle = angle;
  uint16_t& value = target == Target::End ? (position == 'r' ? angles.endRest : angles.endPress)
    : target == Target::Unlock ? (position == 'r' ? angles.unlockRest : angles.unlockPress)
    : (position == 'r' ? angles.callRest : angles.callPress);
  value = static_cast<uint16_t>(angle);
  captureMotion(target);
  const uint16_t hold = target == Target::End ? angles.endPressMs : target == Target::Unlock ? angles.unlockPressMs : angles.callPressMs;
  calibrationPreviewMs = position == 'p' ? hold : 1500;
  servoPreview = true;
  servoPhase = ServoPhase::Calibrating; servoAt = millis(); calibrationReply();
}
}
