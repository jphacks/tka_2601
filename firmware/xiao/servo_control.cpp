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
#if __has_include("device_config.h")
constexpr bool kCloudProvisioned = true;
#else
constexpr bool kCloudProvisioned = false;
#endif
std::recursive_mutex servoLock;
using Guard = std::lock_guard<std::recursive_mutex>;
const char* status = "Servo idle";
enum class PusherId : uint8_t { P1 = 1, P2 = 2, P3 = 3 };
enum class CallAction : uint8_t { Start, End };
enum class ServoPhase { Idle, Wait, Press, Return, Calibrating };
ServoPhase servoPhase = ServoPhase::Idle;
PusherId activePusher = PusherId::P1;
CallAction activeAction = CallAction::Start;
bool servoAttached = false;
bool servoTesting = false, servoTestCancelled = false, servoPreview = false;
const char* motionError = "";
bool callOwned = false, callAttempted = false, endAttempted = false;
bool callActionRequested = false, cancelRequested = false, callDone = false, endDone = false, callFailed = false;
uint32_t servoAt = 0;
uint16_t waitDelayMs = 0;
struct Calibration {
  uint16_t version, callRest, callPress, endRest, endPress, unlockRest, unlockPress;
  uint16_t callDelayMs, callPressMs, endPressMs, unlockPressMs, returnMs;
};
constexpr uint16_t physical(unsigned angle, bool reversed) { return static_cast<uint16_t>(reversed ? 180u - angle : angle); }
constexpr Calibration kDefaultAngles = {1,
  physical(XIAO_SERVO_REST_DEG, XIAO_SERVO_CALL_REVERSED),
  physical(XIAO_SERVO_CALL_PRESS_DEG, XIAO_SERVO_CALL_REVERSED),
  physical(XIAO_SERVO_REST_DEG, XIAO_SERVO_END_REVERSED),
  physical(XIAO_SERVO_END_PRESS_DEG, XIAO_SERVO_END_REVERSED),
  physical(XIAO_SERVO_REST_DEG, XIAO_SERVO_UNLOCK_REVERSED),
  physical(XIAO_SERVO_UNLOCK_PRESS_DEG, XIAO_SERVO_UNLOCK_REVERSED),
  3000, XIAO_SERVO_PRESS_MS, XIAO_SERVO_PRESS_MS, XIAO_SERVO_PRESS_MS, XIAO_SERVO_RETURN_MS};
Calibration angles = kDefaultAngles;
Calibration savedAngles = angles;
constexpr servo_pusher_config_t kDefaultPushers = {0, SERVO_PUSHER_SCHEMA_VERSION, 3, 1, 2};
servo_pusher_config_t pushers = kDefaultPushers, callPushers = kDefaultPushers;
Calibration callAngles = kDefaultAngles;
bool storageReady = false, pusherPending = false;
bool sharedMarked = false, manualRequired = false, interruptedSharedStart = false;
uint32_t storageGeneration = 0;
int storageSlot = -1;
const char* storageError = "";
bool calibrationStored = false;
struct ServoMotion { uint16_t press, rest, holdMs, returnMs; };
ServoMotion motion{};
int commandedAngle = -1;
const char* motionSource = "none";
bool calibrating = false;
uint32_t calibrationAt = 0;
uint32_t calibrationPreviewMs = 1500;

uint8_t pinFor(PusherId target) {
  return target == PusherId::P1 ? PIN_SERVO_CALL : target == PusherId::P2 ? PIN_SERVO_END : PIN_SERVO_UNLOCK;
}
const char* nameFor(PusherId target) {
  return target == PusherId::P1 ? "CALL" : target == PusherId::P2 ? "END" : "UNLOCK";
}
const char* wordFor(PusherId target) {
  return target == PusherId::P1 ? "call" : target == PusherId::P2 ? "end" : "unlock";
}
bool targetFrom(char letter, PusherId& target) {
  if (letter == 'c') target = PusherId::P1;
  else if (letter == 'e') target = PusherId::P2;
  else if (letter == 'u') target = PusherId::P3;
  else return false;
  return true;
}
const char* settingsSource() { return calibrating ? "editing" : calibrationStored ? "saved" : "defaults"; }
void captureMotion(PusherId target) {
  const Calibration& a = callOwned ? callAngles : angles;
  if (target == PusherId::P1) motion = {a.callPress, a.callRest, a.callPressMs, a.returnMs};
  else if (target == PusherId::P2) motion = {a.endPress, a.endRest, a.endPressMs, a.returnMs};
  else motion = {a.unlockPress, a.unlockRest, a.unlockPressMs, a.returnMs};
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
bool validPushers(const servo_pusher_config_t& c) {
  if (c.schema_version != SERVO_PUSHER_SCHEMA_VERSION || c.call_start < 1 || c.call_start > 2 ||
      c.call_end < 1 || c.call_end > 2 || c.enabled_mask < 1 || c.enabled_mask > 3) return false;
  const uint8_t used = static_cast<uint8_t>((1u << (c.call_start - 1u)) | (1u << (c.call_end - 1u)));
  return used == c.enabled_mask &&
    (c.enabled_mask != 3 || (c.call_start != c.call_end && PIN_SERVO_CALL != PIN_SERVO_END));
}
bool samePushers(const servo_pusher_config_t& a, const servo_pusher_config_t& b) {
  return a.revision == b.revision && a.schema_version == b.schema_version &&
    a.enabled_mask == b.enabled_mask && a.call_start == b.call_start && a.call_end == b.call_end;
}
bool shared(const servo_pusher_config_t& c) { return c.call_start == c.call_end; }
bool sharedOutput(PusherId id) {
  return shared(pushers) && static_cast<uint8_t>(id) == pushers.call_start;
}
bool enabledOutput(PusherId id) {
  return id == PusherId::P3 || (pushers.enabled_mask & (1u << (static_cast<uint8_t>(id) - 1u)));
}
PusherId resolvePusher(CallAction action) {
  return static_cast<PusherId>(action == CallAction::Start ? callPushers.call_start : callPushers.call_end);
}
uint16_t get16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t get32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
    (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
void put16(uint8_t* p, uint16_t n) { p[0] = n; p[1] = n >> 8; }
void put32(uint8_t* p, uint32_t n) { for (unsigned i = 0; i < 4; ++i) p[i] = n >> (8u * i); }
uint32_t checksum(const uint8_t* p, size_t n) {
  uint32_t crc = 0xffffffffu;
  for (size_t i = 0; i < n; ++i) {
    crc ^= p[i];
    for (unsigned bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1u) ? 0xedb88320u : 0u);
  }
  return ~crc;
}
constexpr size_t kRecordBytes = 48;
const char* const kSlotKeys[] = {"pusher-a", "pusher-b"};
void encodeRecord(uint8_t* bytes, const Calibration& a, const servo_pusher_config_t& c, uint32_t generation) {
  memset(bytes, 0, kRecordBytes);
  memcpy(bytes, "MPS2", 4); put32(bytes + 4, generation); put32(bytes + 8, c.revision);
  put16(bytes + 12, c.schema_version); bytes[14] = c.enabled_mask;
  bytes[15] = c.call_start; bytes[16] = c.call_end;
  const uint16_t values[] = {a.version, a.callRest, a.callPress, a.endRest, a.endPress, a.unlockRest,
    a.unlockPress, a.callDelayMs, a.callPressMs, a.endPressMs, a.unlockPressMs, a.returnMs};
  for (unsigned i = 0; i < 12; ++i) put16(bytes + 20 + i * 2, values[i]);
  put32(bytes + 44, checksum(bytes, 44));
}
bool decodeRecord(const uint8_t* bytes, Calibration& a, servo_pusher_config_t& c, uint32_t& generation) {
  if (memcmp(bytes, "MPS2", 4) || get32(bytes + 44) != checksum(bytes, 44) ||
      bytes[17] || bytes[18] || bytes[19]) return false;
  generation = get32(bytes + 4);
  c = {get32(bytes + 8), get16(bytes + 12), bytes[14], bytes[15], bytes[16]};
  uint16_t v[12]; for (unsigned i = 0; i < 12; ++i) v[i] = get16(bytes + 20 + i * 2);
  a = {v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[9], v[10], v[11]};
  return generation && validAngles(a) && validPushers(c);
}
bool saveSettings(const Calibration& a, const servo_pusher_config_t& c) {
  Preferences prefs;
  storageError = "storage_unavailable";
  if (!prefs.begin("monban-servo", false)) return false;
  storageError = "save_failed";
  if (storageGeneration == UINT32_MAX) { prefs.end(); return false; }
  uint8_t bytes[kRecordBytes], verified[kRecordBytes];
  if (storageSlot < 0) {
    // Checkpoint the old v1/default state before the first changed record. A
    // power cut during that first change must still leave a readable old state.
    encodeRecord(bytes, savedAngles, pushers, 1);
    const bool checkpoint = prefs.putBytes(kSlotKeys[0], bytes, sizeof(bytes)) == sizeof(bytes) &&
      prefs.getBytesLength(kSlotKeys[0]) == sizeof(bytes) &&
      prefs.getBytes(kSlotKeys[0], verified, sizeof(verified)) == sizeof(verified) &&
      !memcmp(bytes, verified, sizeof(bytes));
    if (!checkpoint) { prefs.end(); return false; }
    storageSlot = 0; storageGeneration = 1;
  }
  encodeRecord(bytes, a, c, storageGeneration + 1u);
  const int nextSlot = storageSlot == 0 ? 1 : 0;
  const bool written = prefs.putBytes(kSlotKeys[nextSlot], bytes, sizeof(bytes)) == sizeof(bytes) &&
    prefs.getBytesLength(kSlotKeys[nextSlot]) == sizeof(bytes) &&
    prefs.getBytes(kSlotKeys[nextSlot], verified, sizeof(verified)) == sizeof(verified) &&
    !memcmp(bytes, verified, sizeof(bytes));
  if (!written) {
    // An unverified candidate is not a committed setting. Keep the other slot
    // intact, and invalidate this slot when storage is still writable.
    const uint8_t invalid[kRecordBytes] = {};
    (void)prefs.putBytes(kSlotKeys[nextSlot], invalid, sizeof(invalid));
  }
  prefs.end();
  if (!written) return false;
  storageSlot = nextSlot; ++storageGeneration; storageReady = true; storageError = "";
  return true;
}
bool writeSharedMarker(bool active) {
  Preferences prefs;
  if (!prefs.begin("monban-servo", false)) return false;
  const uint8_t value = active ? 1 : 0;
  uint8_t verified = 0xff;
  const bool written = prefs.putBytes("shared-op", &value, 1) == 1 &&
    prefs.getBytesLength("shared-op") == 1 && prefs.getBytes("shared-op", &verified, 1) == 1 && verified == value;
  // If clearing cannot be verified, re-arm the durable interlock. A corrupt or
  // unreadable marker also blocks operation on the next boot.
  if (!written && !active) { const uint8_t pending = 1; (void)prefs.putBytes("shared-op", &pending, 1); }
  prefs.end();
  return written;
}
bool prepareSharedOperation(PusherId id) {
  if (!sharedOutput(id)) return true;
  if (manualRequired) return false;
  if (sharedMarked) return true;
  sharedMarked = true;
  if (writeSharedMarker(true)) return true;
  manualRequired = true; motionError = "shared_marker_save_failed";
  return false;
}
bool finishSharedOperation() {
  if (!sharedMarked) return true;
  if (!writeSharedMarker(false)) { manualRequired = true; return false; }
  sharedMarked = false;
  return true;
}
void loadCalibration() {
  angles = savedAngles = kDefaultAngles;
  pushers = kDefaultPushers; storageSlot = -1; storageGeneration = 0;
  storageReady = false; calibrationStored = false; sharedMarked = manualRequired = false;
  Preferences prefs;
  // ESP32 NVS cannot open a namespace read-only before its first creation.
  // Create the empty namespace on first boot; an actual storage failure still
  // inhibits calls and configuration changes.
  if (!prefs.begin("monban-servo", true) && !prefs.begin("monban-servo", false)) return;
  bool hasRecords = false;
  for (int slot = 0; slot < 2; ++slot) {
    const size_t length = prefs.getBytesLength(kSlotKeys[slot]);
    hasRecords = hasRecords || length != 0;
    uint8_t bytes[kRecordBytes]; Calibration a{}; servo_pusher_config_t c{}; uint32_t generation = 0;
    if (length == sizeof(bytes) && prefs.getBytes(kSlotKeys[slot], bytes, sizeof(bytes)) == sizeof(bytes) &&
        decodeRecord(bytes, a, c, generation) && generation > storageGeneration) {
      angles = savedAngles = a; pushers = c; storageGeneration = generation; storageSlot = slot;
    }
  }
  if (storageSlot >= 0) { calibrationStored = storageReady = true; }
  else if (!hasRecords) {
    Calibration stored{};
    const size_t length = prefs.getBytesLength("settings");
    if (!length) storageReady = true;
    else if (length == sizeof(stored) && prefs.getBytes("settings", &stored, sizeof(stored)) == sizeof(stored) && validAngles(stored))
      { angles = savedAngles = stored; calibrationStored = storageReady = true; }
  }
  const size_t markerLength = prefs.getBytesLength("shared-op");
  uint8_t marker = 0xff;
  if (markerLength) {
    sharedMarked = markerLength != 1 || prefs.getBytes("shared-op", &marker, 1) != 1 || marker != 0;
  }
  manualRequired = sharedMarked || !storageReady;
  prefs.end();
}
void calibrationReply(const char* error = nullptr) {
  xlog("[CAL] {\"ok\":%s,\"error\":\"%s\",\"active\":%s,\"call_rest\":%u,\"call_press\":%u,\"end_rest\":%u,\"end_press\":%u,\"unlock_rest\":%u,\"unlock_press\":%u,\"call_delay_ms\":%u,\"call_hold_ms\":%u,\"end_hold_ms\":%u,\"unlock_hold_ms\":%u,\"return_ms\":%u,\"test_busy\":%s,\"test_target\":\"%s\",\"end_mirror_supported\":true,\"settings_source\":\"%s\",\"saved\":{\"call_rest\":%u,\"call_press\":%u,\"end_rest\":%u,\"end_press\":%u,\"unlock_rest\":%u,\"unlock_press\":%u,\"call_delay_ms\":%u,\"call_hold_ms\":%u,\"end_hold_ms\":%u,\"unlock_hold_ms\":%u,\"return_ms\":%u},\"pwm_active\":%s,\"commanded_angle\":%d,\"motion_busy\":%s,\"motion_error\":\"%s\",\"pwm_backend\":\"isolated-ledc\",\"pusher_schema_version\":%u,\"pusher_revision\":%lu,\"enabled_mask\":%u,\"call_start_pusher\":%u,\"call_end_pusher\":%u,\"manual_check_required\":%s,\"pusher_pending\":%s}\n",
    error ? "false" : "true", error ? error : "", calibrating ? "true" : "false",
    angles.callRest, angles.callPress, angles.endRest, angles.endPress, angles.unlockRest, angles.unlockPress,
    angles.callDelayMs, angles.callPressMs, angles.endPressMs, angles.unlockPressMs, angles.returnMs,
    servoTesting ? "true" : "false",
    servoTesting ? (activePusher == PusherId::P1 ? "c" : activePusher == PusherId::P2 ? "e" : "u") : "", settingsSource(),
    savedAngles.callRest, savedAngles.callPress, savedAngles.endRest, savedAngles.endPress,
    savedAngles.unlockRest, savedAngles.unlockPress,
    savedAngles.callDelayMs, savedAngles.callPressMs, savedAngles.endPressMs, savedAngles.unlockPressMs, savedAngles.returnMs,
    servoAttached ? "true" : "false", commandedAngle,
    servoPhase != ServoPhase::Idle ? "true" : "false", motionError,
    pushers.schema_version, static_cast<unsigned long>(pushers.revision), pushers.enabled_mask,
    pushers.call_start, pushers.call_end, manualRequired ? "true" : "false", pusherPending ? "true" : "false");
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
  if (sharedMarked) manualRequired = true;
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
    if (!monban_servo::write(pinFor(activePusher), servoDuty(motion.rest))) {
      monban_servo::detach(pinFor(activePusher));
      servoFailure("servo_return_failed"); return;
    }
    commandedAngle = motion.rest;
    servoPhase = ServoPhase::Return; servoAt = millis();
    xlog("[SERVO] %s returning to %u degrees for %u ms; at_ms=%lu\n",
      nameFor(activePusher), motion.rest, motion.returnMs, (unsigned long)servoAt);
  } else servoPhase = ServoPhase::Idle;
}
bool attachAndPressServo(PusherId target) {
  motionError = "";
  activePusher = target;
  if (!prepareSharedOperation(target)) return false;
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
    if (activeAction == CallAction::End) endAttempted = true;
    else callAttempted = true; // even a partial PWM failure may have moved it
  }
  return attachAndPressServo(activePusher);
}
void startPressFailed() {
  if (shared(callPushers)) { manualRequired = true; interruptedSharedStart = activeAction == CallAction::Start; }
  // A partial attach still returns and detaches the selected servo.
  if (servoAttached) neutralServo();
  if (servoPhase != ServoPhase::Return) {
    if (servoAttached) monban_servo::detach(pinFor(activePusher));
    servoFailure("servo_pwm_failed");
  } else callFailed = true;
}
bool startServo(CallAction action) {
  if (servoPhase != ServoPhase::Idle) { callFailed = true; setStatus("servo_busy"); return false; }
  if (!servoConfigValid()) { callFailed = true; setStatus("servo_config_invalid"); return false; }
  motionError = "";
  if (manualRequired) { callFailed = true; setStatus("manual_check_required"); return false; }
  if (action == CallAction::Start) callActionRequested = true;
  activeAction = action; activePusher = resolvePusher(action); servoAt = millis();
  waitDelayMs = action == CallAction::Start ? callAngles.callDelayMs : 0;
  if (waitDelayMs) {
    servoPhase = ServoPhase::Wait;
    setStatus("Waiting before one call-button press");
    xlog("[SERVO] CALL waiting %u ms; no button pressed yet\n", waitDelayMs);
    return true;
  }
  if (!beginPhysicalServo()) { startPressFailed(); return false; }
  setStatus(action == CallAction::End ? "Pressing end button" : "Pressing call button");
  return true;
}
void testStatus(const char* cancelled, const char* complete) {
  static char text[48];
  snprintf(text, sizeof(text), "Servo test %s: %s", servoTestCancelled ? cancelled : complete, wordFor(activePusher));
  setStatus(text);
}
void completeServo() {
  servoPhase = ServoPhase::Idle;
  if (servoPreview) {
    servoPreview = false;
    static char text[48];
    snprintf(text, sizeof(text), "Calibration preview complete: %s", wordFor(activePusher));
    setStatus(text);
    if (sharedMarked) manualRequired = true;
    return;
  }
  if (servoTesting) {
    servoTesting = false;
    testStatus("cancelled", "complete");
    if (sharedMarked) manualRequired = true;
    return;
  }
  if (!callOwned) return;
  if (shared(callPushers) && (manualRequired || interruptedSharedStart || callFailed)) {
    manualRequired = true; callFailed = true; setStatus("manual_check_required"); return;
  }
  if (cancelRequested && activeAction == CallAction::Start) {
    // The call servo has returned; now end the possibly active intercom call.
    startServo(CallAction::End);
    return;
  }
  if (activeAction == CallAction::End) {
    if (shared(callPushers) && !finishSharedOperation()) {
      callFailed = true; setStatus("manual_check_required"); return;
    }
    endDone = true; setStatus("Call ended");
  }
  else { callDone = true; setStatus("Call started"); }
}
void pollServo() {
  if (calibrating && elapsed(millis(), calibrationAt, 120000)) {
    calibrating = false; angles = savedAngles; neutralServo();
    setStatus("Calibration timed out; unsaved angles discarded");
  } else if (servoPhase == ServoPhase::Calibrating && elapsed(millis(), servoAt, calibrationPreviewMs)) {
    neutralServo();
  }
  if (servoPhase == ServoPhase::Wait && elapsed(millis(), servoAt, waitDelayMs)) {
    if (!beginPhysicalServo()) {
      if (servoTesting) {
        servoTestCancelled = true;
        neutralServo();
        if (servoPhase == ServoPhase::Idle) servoTesting = false; // nothing moved: calls must not stay blocked
        if (sharedMarked) manualRequired = true;
      } else startPressFailed();
    } else setStatus("Pressing call button once");
  } else if (servoPhase == ServoPhase::Press && elapsed(millis(), servoAt, motion.holdMs)) {
    neutralServo();
  } else if (servoPhase == ServoPhase::Return && elapsed(millis(), servoAt, motion.returnMs)) {
    const bool stopped = monban_servo::detach(pinFor(activePusher));
    servoAttached = false;
    if (!stopped) { servoFailure("servo_release_failed"); return; }
    xlog("[SERVO] %s released; PWM stopped; signal LOW; at_ms=%lu\n", nameFor(activePusher), (unsigned long)millis());
    completeServo();
  }
}
bool requestServoTest(PusherId target, bool useCalibration) {
  if ((calibrating && !useCalibration) || callOwned || servoTesting || servoPhase != ServoPhase::Idle) {
    xlog("[STREAM] Servo test refused: servo busy\n");
    return false;
  }
  if (!servoConfigValid()) {
    setStatus("Servo test refused: physical servo configuration required");
    return false;
  }
  if (!storageReady || manualRequired || !enabledOutput(target)) {
    setStatus(manualRequired ? "manual_check_required" : !storageReady ? "storage_unavailable" : "pusher_disabled");
    return false;
  }
  // Do not touch callAttempted/endAttempted. A local diagnostic must never
  // schedule the call's other servo.
  motionError = "";
  servoTesting = true; servoTestCancelled = false;
  activePusher = target; servoAt = millis();
  waitDelayMs = static_cast<uint8_t>(target) == pushers.call_start ? angles.callDelayMs : 0;
  if (waitDelayMs) {
    servoPhase = ServoPhase::Wait;
    setStatus("Servo test waiting before one call press");
    return true;
  }
  if (!attachAndPressServo(target)) {
    servoTestCancelled = true;
    neutralServo();
    if (servoPhase == ServoPhase::Idle) servoTesting = false;
    if (sharedMarked) manualRequired = true;
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
  snprintf(text, sizeof(text), "Servo test returning: %s", wordFor(activePusher));
  setStatus(text);
  return true;
}
bool parsePusherCommand(const char* input, servo_pusher_config_t& out) {
  uint32_t values[4] = {};
  const uint32_t limits[] = {0, 3, 2, 2};
  const char* p = input + 8;
  for (unsigned i = 0; i < 4; ++i) {
    while (*p == ' ' || *p == '\t') ++p;
    if (*p < '0' || *p > '9') return false;
    do {
      const uint32_t digit = static_cast<uint32_t>(*p++ - '0');
      if (values[i] > limits[i] / 10u ||
          (values[i] == limits[i] / 10u && digit > limits[i] % 10u)) return false;
      values[i] = values[i] * 10u + digit;
    } while (*p >= '0' && *p <= '9');
    if (i < 3 && *p != ' ' && *p != '\t') return false;
  }
  while (*p == ' ' || *p == '\t') ++p;
  if (*p || values[0]) return false;
  out = {values[0], SERVO_PUSHER_SCHEMA_VERSION, static_cast<uint8_t>(values[1]),
    static_cast<uint8_t>(values[2]), static_cast<uint8_t>(values[3])};
  return true;
}
}  // namespace

extern "C" {
void servo_begin(void) {
  Guard guard(servoLock);
  if (servoAttached) monban_servo::detach(pinFor(activePusher));
  servoAttached = false; servoPhase = ServoPhase::Idle;
  servoTesting = servoPreview = calibrating = callOwned = false;
  callAttempted = endAttempted = callActionRequested = cancelRequested = false;
  callDone = endDone = callFailed = interruptedSharedStart = false;
  pusherPending = false; motionError = ""; commandedAngle = -1;
  loadCalibration();
  monban_servo::idle(PIN_SERVO_CALL);
  monban_servo::idle(PIN_SERVO_END);
  monban_servo::idle(PIN_SERVO_UNLOCK);
  logServoConfiguration();
  if (manualRequired) setStatus("manual_check_required");
}
void servo_poll(void) {
  Guard guard(servoLock);
  pollServo();
}
bool servo_call_open(void) {
  Guard guard(servoLock);
  if (!storageReady || manualRequired || pusherPending || calibrating || callOwned || servoTesting || servoPhase != ServoPhase::Idle) return false;
  callOwned = true;
  callAttempted = endAttempted = callActionRequested = cancelRequested = false;
  callDone = endDone = callFailed = false;
  interruptedSharedStart = false;
  callPushers = pushers; callAngles = angles;
  return true;
}
bool servo_call_press(void) {
  Guard guard(servoLock);
  if (!callOwned || callActionRequested) return callOwned;
  return startServo(CallAction::Start);
}
bool servo_end_press(void) {
  Guard guard(servoLock);
  if (!callOwned || manualRequired) return false;
  if (endAttempted) return true; // END only once, even if requested again
  if (shared(callPushers) && !callDone) return false;
  return startServo(CallAction::End);
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
    if (shared(callPushers) && !callDone) {
      interruptedSharedStart = true; manualRequired = true;
    }
    neutralServo(); // completeServo schedules END after the call servo returns
    return;
  }
  servoPhase = ServoPhase::Idle;
  if (shared(callPushers) && (manualRequired || (callActionRequested && !callDone))) {
    manualRequired = true; callFailed = true; setStatus("manual_check_required"); return;
  }
  callFailed = false; // the earlier failure is what this cancel is handling
  if (callActionRequested) startServo(CallAction::End);
  else { endDone = true; setStatus("Cancelled before call start"); }
}
servo_call_status_t servo_call_status(void) {
  Guard guard(servoLock);
  if (manualRequired) return SERVO_CALL_MANUAL_CHECK_REQUIRED;
  if (endDone) return SERVO_CALL_ENDED;
  if (callFailed) return SERVO_CALL_FAILED;
  if (callDone && !cancelRequested && !endAttempted) return SERVO_CALL_STARTED;
  return SERVO_CALL_PENDING;
}
void servo_call_close(void) {
  Guard guard(servoLock);
  if (sharedMarked && !endDone) manualRequired = true;
  callOwned = false;
  // Uncertain outcome: never leave a press output latched.
  if (servoPhase == ServoPhase::Press) neutralServo();
  else if (servoPhase == ServoPhase::Wait) servoPhase = ServoPhase::Idle;
}
bool servo_pusher_get(servo_pusher_config_t *out) {
  Guard guard(servoLock);
  if (!out || !storageReady) return false;
  *out = pushers;
  return true;
}
servo_config_result_t servo_pusher_apply(const servo_pusher_config_t *config) {
  Guard guard(servoLock);
  if (!config) return SERVO_CONFIG_INVALID;
  if (config->schema_version != SERVO_PUSHER_SCHEMA_VERSION) return SERVO_CONFIG_UNSUPPORTED_SCHEMA;
  if (!validPushers(*config) || !config->revision) return SERVO_CONFIG_INVALID;
  if (config->revision < pushers.revision) return SERVO_CONFIG_STALE_REVISION;
  if (config->revision == pushers.revision)
    return samePushers(*config, pushers) ? SERVO_CONFIG_UNCHANGED : SERVO_CONFIG_REVISION_CONFLICT;
  if (manualRequired) return SERVO_CONFIG_RECOVERY_REQUIRED;
  if (!storageReady) return SERVO_CONFIG_STORAGE_FAILED;
  if (callOwned || calibrating || servoTesting || servoPhase != ServoPhase::Idle) return SERVO_CONFIG_BUSY;
  if (!saveSettings(angles, *config)) return SERVO_CONFIG_STORAGE_FAILED;
  pushers = *config; savedAngles = angles; calibrationStored = true;
  setStatus("Pusher assignments saved");
  return SERVO_CONFIG_APPLIED;
}
servo_config_result_t servo_pusher_apply_local(const servo_pusher_config_t *config) {
  Guard guard(servoLock);
  if (!config || config->revision || !validPushers(*config)) return SERVO_CONFIG_INVALID;
  // Local wiring stays at revision zero so a future cloud revision one can
  // replace it. A provisioned device's revision space is owned by the server.
  if (kCloudProvisioned || pushers.revision) return SERVO_CONFIG_CLOUD_MANAGED;
  if (manualRequired) return SERVO_CONFIG_RECOVERY_REQUIRED;
  if (!storageReady) return SERVO_CONFIG_STORAGE_FAILED;
  if (pusherPending || callOwned || calibrating || servoTesting || servoPhase != ServoPhase::Idle) return SERVO_CONFIG_BUSY;
  if (samePushers(*config, pushers)) return SERVO_CONFIG_UNCHANGED;
  if (!saveSettings(angles, *config)) return SERVO_CONFIG_STORAGE_FAILED;
  pushers = *config; savedAngles = angles; calibrationStored = true;
  setStatus("Local pusher wiring saved; cloud revision unchanged");
  return SERVO_CONFIG_APPLIED;
}
const char *servo_pusher_result_error(servo_config_result_t result) {
  switch (result) {
    case SERVO_CONFIG_APPLIED: case SERVO_CONFIG_UNCHANGED: return "";
    case SERVO_CONFIG_BUSY: return "busy";
    case SERVO_CONFIG_INVALID: return "invalid_pusher_config";
    case SERVO_CONFIG_UNSUPPORTED_SCHEMA: return "unsupported_schema";
    case SERVO_CONFIG_STALE_REVISION: return "stale_revision";
    case SERVO_CONFIG_REVISION_CONFLICT: return "revision_conflict";
    case SERVO_CONFIG_STORAGE_FAILED: return "storage_failed";
    case SERVO_CONFIG_RECOVERY_REQUIRED: return "manual_check_required";
    case SERVO_CONFIG_CLOUD_MANAGED: return "cloud_managed";
  }
  return "invalid_result";
}
uint8_t servo_pusher_pin(uint8_t physical_id) {
  return physical_id >= 1 && physical_id <= 3 ? pinFor(static_cast<PusherId>(physical_id)) : UINT8_MAX;
}
void servo_pusher_set_pending(bool pending) { Guard guard(servoLock); pusherPending = pending; }
bool servo_recovery_required(void) { Guard guard(servoLock); return manualRequired; }
bool servo_recovery_confirm(void) {
  Guard guard(servoLock);
  if (!storageReady || callOwned || servoTesting || servoAttached || servoPhase != ServoPhase::Idle) return false;
  if (!manualRequired && !sharedMarked) return true;
  if (!finishSharedOperation()) return false;
  manualRequired = false; interruptedSharedStart = false; callFailed = false;
  setStatus("Intercom idle confirmed; no motion");
  return true;
}
bool servo_test(char letter) {
  Guard guard(servoLock);
  PusherId target;
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
  if (!strcmp(command, "@confirm")) {
    calibrationReply(servo_recovery_confirm() ? nullptr : "recovery_confirmation_failed"); return;
  }
  if (!strncmp(command, "@pusher ", 8)) {
    servo_pusher_config_t c{};
    if (!parsePusherCommand(command, c)) {
      calibrationReply("invalid_pusher_config"); return;
    }
    const char* error = servo_pusher_result_error(servo_pusher_apply_local(&c));
    calibrationReply(error[0] ? error : nullptr); return;
  }
  if (!strcmp(command, "@stop")) {
    if (!cancelServoTest()) { calibrationReply("test_not_running"); return; }
    calibrationReply(); return;
  }
  if (!strcmp(command, "@test c") || !strcmp(command, "@test e") || !strcmp(command, "@test u")) {
    PusherId testPusher = PusherId::P1;
    targetFrom(command[6], testPusher);
    if (!requestServoTest(testPusher, true)) {
      calibrationReply(manualRequired ? "manual_check_required" : !enabledOutput(testPusher) ? "pusher_disabled" : "receiver_busy");
      return;
    }
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
    if (!saveSettings(angles, pushers)) { calibrationReply(storageError); return; }
    savedAngles = angles; calibrationStored = true; calibrating = false; neutralServo();
    setStatus("Servo angles saved"); calibrationReply(); return;
  }
  char letter = 0, position = 0, extra = 0; int angle = -1;
  PusherId target = PusherId::P1;
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
    if (target == PusherId::P2) { angles.endRest = rest; angles.endPress = press; }
    else if (target == PusherId::P3) { angles.unlockRest = rest; angles.unlockPress = press; }
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
  if (!enabledOutput(target)) { calibrationReply("pusher_disabled"); return; }
  if (manualRequired) { calibrationReply("manual_check_required"); return; }
  // Finish returning the previous servo before switching to the other one.
  if (servoAttached && activePusher != target) {
    if (servoPhase != ServoPhase::Return) neutralServo();
    calibrationReply("returning_previous_servo"); return;
  }
  if (servoPhase != ServoPhase::Idle) { calibrationReply("servo_busy"); return; }
  motionError = "";
  activePusher = target;
  if (!prepareSharedOperation(target)) { calibrationReply("shared_marker_save_failed"); return; }
  if (!servoAttached) servoAttached = monban_servo::attach(pin);
  if (!servoAttached) {
    if (sharedMarked) manualRequired = true;
    calibrationReply("pwm_unavailable"); return;
  }
  if (!monban_servo::write(pin, servoDuty(static_cast<unsigned>(angle)))) {
    captureMotion(target);
    if (sharedMarked) manualRequired = true;
    neutralServo(); calibrationReply("pwm_write_failed"); return;
  }
  commandedAngle = angle;
  uint16_t& value = target == PusherId::P2 ? (position == 'r' ? angles.endRest : angles.endPress)
    : target == PusherId::P3 ? (position == 'r' ? angles.unlockRest : angles.unlockPress)
    : (position == 'r' ? angles.callRest : angles.callPress);
  value = static_cast<uint16_t>(angle);
  captureMotion(target);
  const uint16_t hold = target == PusherId::P2 ? angles.endPressMs : target == PusherId::P3 ? angles.unlockPressMs : angles.callPressMs;
  calibrationPreviewMs = position == 'p' ? hold : 1500;
  servoPreview = true;
  servoPhase = ServoPhase::Calibrating; servoAt = millis(); calibrationReply();
}
}
