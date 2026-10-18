#include "stream_receiver.h"
#include "stream_protocol.h"
#include <M5Unified.h>
#include <WiFi.h>
#include <lwip/sockets.h>
#include <errno.h>
#include <Preferences.h>

#if __has_include("servo_config.h")
#include "servo_config.h"
#else
#include "servo_config.example.h"
#endif

// Keep existing calibration files compatible until they opt into reversal.
#ifndef M5_SERVO_CALL_REVERSED
#define M5_SERVO_CALL_REVERSED 0
#endif
#ifndef M5_SERVO_END_REVERSED
#define M5_SERVO_END_REVERSED 0
#endif
#ifndef M5_SERVO_CALL_PRESS_DEG
#define M5_SERVO_CALL_PRESS_DEG M5_SERVO_PRESS_DEG
#endif
#ifndef M5_SERVO_END_PRESS_DEG
#define M5_SERVO_END_PRESS_DEG M5_SERVO_PRESS_DEG
#endif

namespace e84stream {
namespace {
constexpr uint32_t kDmaDrainMs = 30;
constexpr uint32_t kPartialTimeoutMs = 5000;
constexpr uint32_t kIdleTimeoutMs = 180000;
constexpr uint32_t kOutputTimeoutMs = 15000;
WiFiServer server(0, 1);
WiFiClient client;
AudioQueue audio;
Session session;
SessionHistory history;
const char* pairingToken = nullptr;
const char* status = "Waiting for E84";
uint16_t port = 0;
IPAddress boundIp;
bool listening = false, authenticated = false, clientPresent = false;
bool speakerReady = false, primed = false, draining = false;
size_t submitted = 0;
uint32_t drainAt = 0, lastPacket = 0, lastOutput = 0, packetAt = 0, bindAt = 0;
uint32_t lastPlaybackProgress = 0;
uint8_t wire[kHeaderBytes + kMaxPayload];
size_t received = 0;
Header incoming;
bool headerReady = false;
uint8_t tx[2048];
size_t txUsed = 0;
uint32_t txAt = 0;
enum class ServoPhase { Idle, Wait, Press, Return, Manual, Calibrating };
ServoPhase servoPhase = ServoPhase::Idle;
bool servoEnding = false, servoAttached = false;
bool servoTesting = false, servoTestCancelled = false;
bool callAttempted = false, endAttempted = false, failsafeEndPending = false;
bool callActionRequested = false, cancelRequested = false;
uint32_t servoAt = 0;
uint8_t activeServoPin = M5_SERVO_CALL_PIN;
struct Calibration {
  uint16_t version, callRest, callPress, endRest, endPress;
  uint16_t callDelayMs, callPressMs, endPressMs, returnMs;
};
constexpr uint16_t physical(unsigned angle, bool reversed) { return static_cast<uint16_t>(reversed ? 180u - angle : angle); }
Calibration angles = {2,
  physical(M5_SERVO_REST_DEG, M5_SERVO_CALL_REVERSED),
  physical(M5_SERVO_CALL_PRESS_DEG, M5_SERVO_CALL_REVERSED),
  physical(M5_SERVO_REST_DEG, M5_SERVO_END_REVERSED),
  physical(M5_SERVO_END_PRESS_DEG, M5_SERVO_END_REVERSED),
  3000, M5_SERVO_PRESS_MS, M5_SERVO_PRESS_MS, M5_SERVO_RETURN_MS};
Calibration savedAngles = angles;
bool calibrationStored = false;
struct ServoMotion { uint16_t press, rest, holdMs, returnMs; };
ServoMotion motion{};
int commandedAngle = -1;
const char* motionSource = "none";
bool calibrating = false;
uint32_t calibrationAt = 0;
uint32_t calibrationPreviewMs = 1500;
unsigned restAngle() { return motion.rest; }
const char* settingsSource() { return calibrating ? "editing" : calibrationStored ? "saved" : "defaults"; }
void captureMotion(bool ending) {
  motion = {ending ? angles.endPress : angles.callPress, ending ? angles.endRest : angles.callRest,
            ending ? angles.endPressMs : angles.callPressMs, angles.returnMs};
  motionSource = settingsSource();
}
bool validAngles(const Calibration& a) {
  return a.version == 2 && a.callRest <= 180 && a.callPress <= 180 &&
         a.endRest <= 180 && a.endPress <= 180 && a.callDelayMs <= 30000 &&
         a.callPressMs >= 100 && a.callPressMs <= 2000 &&
         a.endPressMs >= 100 && a.endPressMs <= 2000 &&
         a.returnMs >= 100 && a.returnMs <= 3000;
}
void loadCalibration() {
  Preferences prefs;
  if (!prefs.begin("e84-servo", true)) return;
  Calibration stored{};
  calibrationStored = false;
  if (prefs.getBytesLength("settings") == sizeof(stored) &&
      prefs.getBytes("settings", &stored, sizeof(stored)) == sizeof(stored) && validAngles(stored))
    { angles = savedAngles = stored; calibrationStored = true; }
  else {
    struct Legacy { uint16_t version, callRest, callPress, endRest, endPress; } legacy{};
    if (prefs.getBytesLength("angles") == sizeof(legacy) &&
        prefs.getBytes("angles", &legacy, sizeof(legacy)) == sizeof(legacy) &&
        legacy.version == 1 && legacy.callRest <= 180 && legacy.callPress <= 180 &&
        legacy.endRest <= 180 && legacy.endPress <= 180) {
      angles.callRest = legacy.callRest; angles.callPress = legacy.callPress;
      angles.endRest = legacy.endRest; angles.endPress = legacy.endPress;
      savedAngles = angles; calibrationStored = true;
    }
  }
  prefs.end();
}
void calibrationReply(const char* error = nullptr) {
  Serial.printf("[CAL] {\"ok\":%s,\"error\":\"%s\",\"active\":%s,\"call_rest\":%u,\"call_press\":%u,\"end_rest\":%u,\"end_press\":%u,\"call_delay_ms\":%u,\"call_hold_ms\":%u,\"end_hold_ms\":%u,\"return_ms\":%u,\"test_busy\":%s,\"test_target\":\"%s\",\"end_mirror_supported\":true,\"settings_source\":\"%s\",\"saved\":{\"call_rest\":%u,\"call_press\":%u,\"end_rest\":%u,\"end_press\":%u,\"call_delay_ms\":%u,\"call_hold_ms\":%u,\"end_hold_ms\":%u,\"return_ms\":%u},\"pwm_active\":%s,\"commanded_angle\":%d}\n",
    error ? "false" : "true", error ? error : "", calibrating ? "true" : "false",
    angles.callRest, angles.callPress, angles.endRest, angles.endPress,
    angles.callDelayMs, angles.callPressMs, angles.endPressMs, angles.returnMs,
    servoTesting ? "true" : "false", servoTesting ? (servoEnding ? "e" : "c") : "", settingsSource(),
    savedAngles.callRest, savedAngles.callPress, savedAngles.endRest, savedAngles.endPress,
    savedAngles.callDelayMs, savedAngles.callPressMs, savedAngles.endPressMs, savedAngles.returnMs,
    servoAttached ? "true" : "false", commandedAngle);
}

uint32_t servoDuty(unsigned angle) {
  const uint32_t pulse = M5_SERVO_MIN_US +
    static_cast<uint32_t>(M5_SERVO_MAX_US - M5_SERVO_MIN_US) * angle / 180u;
  return pulse * 65536u / 20000u;
}

bool elapsed(uint32_t now, uint32_t then, uint32_t period) {
  return static_cast<uint32_t>(now - then) >= period;
}
void setStatus(const char* value) {
  status = value;
  Serial.printf("[STREAM] %s\n", value);
}
void logServoConfiguration() {
  Serial.printf("[SERVO] Active source=%s CALL: GPIO=%d press=%u rest=%u; END: GPIO=%d press=%u rest=%u\n",
    settingsSource(), M5_SERVO_CALL_PIN, angles.callPress, angles.callRest,
    M5_SERVO_END_PIN, angles.endPress, angles.endRest);
  Serial.printf("[SERVO] Settings PWM=50Hz range_us=%d..%d press_ms=%d return_ms=%d\n",
    M5_SERVO_MIN_US, M5_SERVO_MAX_US, angles.callPressMs, angles.returnMs);
  Serial.printf("[SERVO] Saved CALL wait=%u ms hold=%u ms; END hold=%u ms; return=%u ms\n",
    angles.callDelayMs, angles.callPressMs, angles.endPressMs, angles.returnMs);
}
bool prepareSpeaker() {
  if (speakerReady) return true;
  auto config = M5.Speaker.config();
  config.sample_rate = 192000;
  config.dma_buf_len = 256;
  config.dma_buf_count = 8;
  M5.Speaker.config(config);
  M5.Speaker.setVolume(100);
  speakerReady = M5.Speaker.begin();
  return speakerReady;
}
void stopAudio() {
  // end() joins the audio task and stops I2S before any PCM storage is reused.
  if (speakerReady) M5.Speaker.end();
  speakerReady = false;
  audio.clear(); submitted = 0; primed = draining = false;
}
void neutralServo() {
  // Returning is idempotent: save/cancel/disconnect cannot rewrite the target
  // or restart its timer while the same return operation is already running.
  if (servoPhase == ServoPhase::Return) return;
  if (servoAttached) {
    // Keep the return pulse active for the configured return interval even
    // after a socket disconnect, then detach in pollServo().
    ledcWrite(activeServoPin, servoDuty(restAngle()));
    commandedAngle = restAngle();
    servoPhase = ServoPhase::Return; servoAt = millis();
    Serial.printf("[SERVO] %s returning to %u degrees for %u ms; at_ms=%lu\n",
      servoEnding ? "END" : "CALL", restAngle(), motion.returnMs, (unsigned long)servoAt);
  } else servoPhase = ServoPhase::Idle;
}
void closeClient() {
  client.stop(); clientPresent = authenticated = false;
  received = txUsed = 0; headerReady = false;
  stopAudio(); neutralServo();
  if (callAttempted && !endAttempted) {
    if (M5_SERVO_ENABLED) failsafeEndPending = true;
    else if (M5_SERVO_MANUAL_TEST) setStatus("MANUAL: close intercom call yourself");
  }
}
bool flushTx() {
  if (!txUsed) return true;
  const int amount = ::send(client.fd(), tx, txUsed, MSG_DONTWAIT);
  if (amount > 0) {
    memmove(tx, tx + amount, txUsed - amount); txUsed -= amount;
    txAt = millis();
    return true;
  }
  return amount < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) &&
         !elapsed(millis(), txAt, kPartialTimeoutMs);
}
bool reply(Type type, uint32_t turn, uint32_t sequence = 0, const char* message = nullptr) {
  Header h; h.type = type; h.session = session.id(); h.turn = turn;
  h.sequence = sequence; h.length = message ? strlen(message) : 0;
  if (txUsed + kHeaderBytes + h.length > sizeof(tx)) return false;
  if (!txUsed) txAt = millis();
  encodeHeader(h, tx + txUsed);
  if (h.length) memcpy(tx + txUsed + kHeaderBytes, message, h.length);
  txUsed += kHeaderBytes + h.length;
  return flushTx();
}
void fail(const char* reason) {
  setStatus(reason);
  if (authenticated) reply(Type::Error, session.turn(), 0, reason);
  closeClient();
}
bool servoConfigValid() {
  return !(M5_SERVO_ENABLED && M5_SERVO_MANUAL_TEST) &&
    (M5_SERVO_CALL_REVERSED == 0 || M5_SERVO_CALL_REVERSED == 1) &&
    (M5_SERVO_END_REVERSED == 0 || M5_SERVO_END_REVERSED == 1) &&
    (M5_SERVO_CALL_PIN == 26 || M5_SERVO_CALL_PIN == 16 || M5_SERVO_CALL_PIN == 17) &&
    (M5_SERVO_END_PIN == 26 || M5_SERVO_END_PIN == 16 || M5_SERVO_END_PIN == 17) &&
    M5_SERVO_MIN_US >= 500 && M5_SERVO_MIN_US < M5_SERVO_MAX_US && M5_SERVO_MAX_US <= 2500 &&
    M5_SERVO_REST_DEG >= 0 && M5_SERVO_REST_DEG <= 180 &&
    M5_SERVO_PRESS_DEG >= 0 && M5_SERVO_PRESS_DEG <= 180 &&
    M5_SERVO_CALL_PRESS_DEG >= 0 && M5_SERVO_CALL_PRESS_DEG <= 180 &&
    M5_SERVO_END_PRESS_DEG >= 0 && M5_SERVO_END_PRESS_DEG <= 180 &&
    M5_SERVO_PRESS_MS >= 100 && M5_SERVO_PRESS_MS <= 2000 &&
    M5_SERVO_RETURN_MS >= 100 && M5_SERVO_RETURN_MS <= 3000;
}
bool attachAndPressServo(bool ending) {
  activeServoPin = ending ? M5_SERVO_END_PIN : M5_SERVO_CALL_PIN;
  // Explicit channel 6 avoids the LCD backlight's LEDC channel.
  servoAttached = ledcAttachChannel(activeServoPin, 50, 16, 6);
  if (!servoAttached) return false;
  captureMotion(ending);
  const unsigned pressAngle = motion.press;
  if (!ledcWrite(activeServoPin, servoDuty(pressAngle))) return false;
  commandedAngle = pressAngle;
  servoPhase = ServoPhase::Press;
  servoAt = millis();
  Serial.printf("[SERVO] %s press once: %u degrees for %u ms; source=%s rest=%u pulse_us=%u at_ms=%lu\n",
    ending ? "END" : "CALL", pressAngle, motion.holdMs, motionSource, motion.rest,
    M5_SERVO_MIN_US + (M5_SERVO_MAX_US-M5_SERVO_MIN_US)*pressAngle/180u, (unsigned long)servoAt);
  return true;
}
bool beginPhysicalServo() {
  if (!servoTesting) {
    if (servoEnding) endAttempted = true;
    else callAttempted = true; // even a partial PWM failure may have moved it
  }
  return attachAndPressServo(servoEnding);
}
bool startServo(bool ending) {
  if (servoPhase != ServoPhase::Idle) { fail("servo_busy"); return false; }
  if (!servoConfigValid()) { fail("servo_config_invalid"); return false; }
  if (!M5_SERVO_ENABLED && !M5_SERVO_MANUAL_TEST) { fail("servo_disabled"); return false; }
  if (!ending) callActionRequested = true;
  servoEnding = ending; servoAt = millis();
  if (M5_SERVO_MANUAL_TEST) {
    servoPhase = ServoPhase::Manual;
    setStatus(ending ? "MANUAL: press end, then M5 C" : "MANUAL: press call, then M5 A");
    return true;
  }
  if (!ending && angles.callDelayMs) {
    servoPhase = ServoPhase::Wait;
    setStatus("Waiting before one call-button press");
    Serial.printf("[SERVO] CALL waiting %u ms; no button pressed yet\n", angles.callDelayMs);
    return true;
  }
  if (!beginPhysicalServo()) {
    fail("servo_pwm_failed"); return false;
  }
  setStatus(ending ? "Pressing end button" : "Pressing call button");
  return true;
}
void completeServo() {
  servoPhase = ServoPhase::Idle;
  if (servoTesting) {
    servoTesting = false;
    setStatus(servoTestCancelled
      ? (servoEnding ? "Servo test cancelled: end" : "Servo test cancelled: call")
      : (servoEnding ? "Servo test complete: end" : "Servo test complete: call"));
    return;
  }
  if (!authenticated) {
    if (servoEnding && endAttempted) setStatus("Disconnected: end press completed");
    return;
  }
  if (cancelRequested && !servoEnding) {
    // The call servo has returned; now end the possibly active intercom call.
    startServo(true);
    return;
  }
  if (servoEnding) endAttempted = true;
  else callAttempted = true;
  const bool valid = servoEnding ? session.callEnded() : session.callStarted();
  if (!valid) { fail("servo_state_invalid"); return; }
  if (!reply(servoEnding ? Type::CallEnded : Type::CallStarted, servoEnding ? session.turn() : 0)) {
    fail("send_failed"); return;
  }
  setStatus(servoEnding ? "Call ended" : "Call started");
}
void pollServo(bool confirmStart, bool confirmEnd) {
  if (calibrating && elapsed(millis(), calibrationAt, 120000)) {
    calibrating = false; angles = savedAngles; neutralServo();
    setStatus("Calibration timed out; unsaved angles discarded");
  } else if (servoPhase == ServoPhase::Calibrating && elapsed(millis(), servoAt, calibrationPreviewMs)) {
    neutralServo();
  }
  if (servoPhase == ServoPhase::Idle && failsafeEndPending) {
    failsafeEndPending = false;
    startServo(true);
  }
  if (servoPhase == ServoPhase::Wait && elapsed(millis(), servoAt, angles.callDelayMs)) {
    if (!beginPhysicalServo()) {
      if (servoTesting) { servoTestCancelled = true; neutralServo(); }
      else fail("servo_pwm_failed");
    } else setStatus("Pressing call button once");
  } else if (servoPhase == ServoPhase::Manual) {
    if (servoEnding ? confirmEnd : confirmStart) completeServo();
    else if (elapsed(millis(), servoAt, 60000)) fail("manual_confirmation_timeout");
  } else if (servoPhase == ServoPhase::Press && elapsed(millis(), servoAt, motion.holdMs)) {
    neutralServo();
  } else if (servoPhase == ServoPhase::Return && elapsed(millis(), servoAt, motion.returnMs)) {
    ledcDetach(activeServoPin); servoAttached = false;
    Serial.printf("[SERVO] %s released; PWM detached; at_ms=%lu\n", servoEnding ? "END" : "CALL", (unsigned long)millis());
    completeServo();
  }
}
void pumpAudio() {
  if (!authenticated || !session.outputActive()) return;
  // With one producer and no stop() between queued requests, count decreases
  // release the oldest buffer. The ring has >=3 distinct buffers; no queued
  // pointer is refilled while the asynchronous speaker task still reads it.
  const size_t playing = M5.Speaker.isPlaying(0);
  while (submitted > playing) { audio.pop(); --submitted; lastPlaybackProgress = millis(); }
  if (!primed && (audio.size() >= kPrebufferFrames || session.outputEnded())) primed = true;
  while (primed && submitted < audio.size() && submitted < 2) {
    if (!submitted) lastPlaybackProgress = millis();
    if (!M5.Speaker.playRaw(audio.samples(submitted), audio.sampleCount(submitted),
                            16000, false, 1, 0, false)) {
      fail("speaker_queue_failed"); return;
    }
    ++submitted; draining = false;
  }
  if (session.outputEnded() && audio.size() == 0 && submitted == 0 && !M5.Speaker.isPlaying(0)) {
    if (!draining) { draining = true; drainAt = millis(); }
    else if (elapsed(millis(), drainAt, kDmaDrainMs)) {
      if (!session.playbackFinished() || !reply(Type::PlaybackDone, session.turn(), session.frames())) {
        fail("playback_completion_failed"); return;
      }
      draining = primed = false;
      setStatus("Playback finished");
    }
  }
  // An underrun/EOF is never completion. Resume when data returns, or abort.
  if (!session.outputEnded() && elapsed(millis(), lastOutput, kOutputTimeoutMs))
    fail("audio_progress_timeout");
  else if (submitted && elapsed(millis(), lastPlaybackProgress, 5000))
    fail("speaker_progress_timeout");
}
void processPacket() {
  const uint8_t* payload = wire + kHeaderBytes;
  if (!authenticated) {
    if (incoming.type != Type::Hello || !tokenMatches(payload, incoming.length, pairingToken) ||
        history.contains(incoming.session) || servoPhase != ServoPhase::Idle || failsafeEndPending) {
      closeClient(); return;
    }
    session.begin(incoming.session);
    authenticated = true;
    callAttempted = endAttempted = false;
    callActionRequested = cancelRequested = false;
    history.remember(incoming.session);
    if (!prepareSpeaker() || !reply(Type::Ready, 0)) { fail("speaker_or_link_unavailable"); return; }
    setStatus("E84 authenticated");
    return;
  }
  const Action action = session.accept(incoming);
  bool ok = true;
  switch (action) {
    case Action::Pending: break;
    case Action::StartCall: startServo(false); break;
    case Action::Started: ok = reply(Type::CallStarted, 0); break;
    case Action::StartOutput:
      if (audio.size() || submitted || !prepareSpeaker()) { fail("speaker_busy"); return; }
      primed = draining = false; lastOutput = lastPlaybackProgress = millis();
      setStatus("Receiving speech"); break;
    case Action::Audio:
      if (!audio.push(payload, incoming.length)) { fail("audio_queue_full"); return; }
      lastOutput = millis(); ok = reply(Type::AudioAck, session.turn(), session.frames()); break;
    case Action::EndOutput: lastOutput = millis(); break;
    case Action::EndCall: startServo(true); break;
    case Action::Ended: ok = reply(Type::CallEnded, session.turn()); break;
    case Action::Cancel:
      if (cancelRequested) break; // do not restart a pending physical operation
      cancelRequested = true;
      stopAudio(); setStatus("Cancelling call; audio stopped");
      if (servoPhase != ServoPhase::Idle && servoEnding) break;
      if (servoPhase == ServoPhase::Wait && !callAttempted) {
        servoPhase = ServoPhase::Idle; callActionRequested = false;
        ok = session.callEnded() && reply(Type::CallEnded, session.turn());
        setStatus("Cancelled during wait; no button pressed");
        break;
      }
      if (servoPhase == ServoPhase::Press || servoPhase == ServoPhase::Return) {
        neutralServo(); // completeServo schedules END after the call servo returns
      } else {
        servoPhase = ServoPhase::Idle;
        if (callActionRequested) startServo(true);
        else {
          ok = session.callEnded() && reply(Type::CallEnded, session.turn());
          setStatus("Cancelled before call start");
        }
      }
      break;
    case Action::Pong: ok = reply(Type::Pong, incoming.turn, incoming.sequence); break;
    default: fail("unexpected_packet"); return;
  }
  if (!ok) fail("send_failed");
}
void receivePackets() {
  for (unsigned count = 0; count < 4 && clientPresent; ++count) {
    // Leave data in TCP while full, propagating backpressure to E84/server.
    if (audio.full()) return;
    const size_t target = headerReady ? kHeaderBytes + incoming.length : kHeaderBytes;
    const int available = client.available();
    if (received < target && available > 0) {
      size_t wanted = target - received;
      if (wanted > static_cast<size_t>(available)) wanted = available;
      const int got = client.read(wire + received, wanted);
      if (got <= 0) { fail("read_failed"); return; }
      if (received == 0) packetAt = millis();
      received += got;
    }
    if (received < target) return;
    if (!headerReady) {
      if (!decodeHeader(wire, incoming)) { fail("invalid_header"); return; }
      headerReady = true;
      if (incoming.length) continue;
    }
    if (received == kHeaderBytes + incoming.length) {
      lastPacket = millis(); processPacket(); received = 0; headerReady = false;
    }
  }
}
}  // namespace

void beginReceiver(uint16_t tcpPort, const char* token) {
  port = tcpPort; pairingToken = token;
  loadCalibration();
  Serial.printf("[STREAM] TCP port=%u PCM=16000/16bit/mono servo=%s\n", port,
    M5_SERVO_ENABLED ? "enabled" : (M5_SERVO_MANUAL_TEST ? "MANUAL TEST" : "disabled"));
  logServoConfiguration();
}
bool requestServoTest(bool ending, bool useCalibration) {
  if ((calibrating && !useCalibration) || clientPresent || authenticated || servoTesting ||
      servoPhase != ServoPhase::Idle || failsafeEndPending) {
    Serial.printf("[STREAM] Servo test refused: receiver busy\n");
    return false;
  }
  if (!servoConfigValid() || !M5_SERVO_ENABLED || M5_SERVO_MANUAL_TEST) {
    setStatus("Servo test refused: physical servo configuration required");
    return false;
  }
  // Do not touch callAttempted/endAttempted or the protocol session. A local
  // diagnostic must never schedule the disconnect failsafe's other servo.
  servoTesting = true; servoTestCancelled = false;
  servoEnding = ending; servoAt = millis();
  if (!ending && angles.callDelayMs) {
    servoPhase = ServoPhase::Wait;
    setStatus("Servo test waiting before one call press");
    return true;
  }
  if (!attachAndPressServo(ending)) {
    servoTestCancelled = true;
    neutralServo();
    if (servoPhase == ServoPhase::Idle) servoTesting = false;
    setStatus("Servo test failed: PWM unavailable");
    return false;
  }
  setStatus(ending ? "Servo test pressing: end" : "Servo test pressing: call");
  return true;
}
bool cancelServoTest() {
  if (!servoTesting) return false;
  servoTestCancelled = true;
  // Repeated cancel must not keep extending the return interval.
  if (servoPhase == ServoPhase::Wait) { servoPhase = ServoPhase::Idle; servoTesting = false; }
  else if (servoPhase == ServoPhase::Press) neutralServo();
  setStatus(servoEnding ? "Servo test returning: end" : "Servo test returning: call");
  return true;
}
bool servoTestBusy() { return servoTesting; }
bool servoMotionBusy() { return servoAttached || servoPhase == ServoPhase::Wait; }
bool calibrationActive() { return calibrating; }
void calibrationCommand(const char* command) {
  if (!strcmp(command, "@get")) { calibrationReply(); return; }
  if (!strcmp(command, "@stop")) {
    if (!cancelServoTest()) { calibrationReply("test_not_running"); return; }
    calibrationReply(); return;
  }
  if (!strcmp(command, "@test c") || !strcmp(command, "@test e")) {
    if (!requestServoTest(command[6] == 'e', true)) { calibrationReply("receiver_busy"); return; }
    if (calibrating) calibrationAt = millis();
    calibrationReply(); return;
  }
  if (servoTesting) { calibrationReply("servo_test_busy"); return; }
  if (!strcmp(command, "@begin")) {
    if (calibrating) { calibrationAt = millis(); calibrationReply(); return; }
    if (clientPresent || authenticated || servoTesting || servoPhase != ServoPhase::Idle || failsafeEndPending) {
      calibrationReply("receiver_busy"); return;
    }
    if (!servoConfigValid() || !M5_SERVO_ENABLED || M5_SERVO_MANUAL_TEST) {
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
    if (!prefs.begin("e84-servo", false)) { calibrationReply("storage_unavailable"); return; }
    Calibration verified{};
    const bool written = prefs.putBytes("settings", &angles, sizeof(angles)) == sizeof(angles) &&
      prefs.getBytes("settings", &verified, sizeof(verified)) == sizeof(verified) &&
      !memcmp(&verified, &angles, sizeof(angles));
    prefs.end();
    if (!written) { calibrationReply("save_failed"); return; }
    savedAngles = angles; calibrationStored = true; calibrating = false; neutralServo();
    setStatus("Servo angles saved"); calibrationReply(); return;
  }
  char target = 0, position = 0, extra = 0; int angle = -1;
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
    if (sscanf(command, "@angles %c %d %d %c", &target, &rest, &press, &extra) != 3 ||
        (target != 'c' && target != 'e') || rest < 0 || rest > 180 || press < 0 || press > 180) {
      calibrationReply("invalid_angles"); return;
    }
    if (servoPhase != ServoPhase::Idle || servoAttached) { calibrationReply("servo_busy"); return; }
    // Restore editor values after an update without previewing or moving.
    if (target == 'e') { angles.endRest = rest; angles.endPress = press; }
    else { angles.callRest = rest; angles.callPress = press; }
    calibrationReply(); return;
  }
  if (!strncmp(command, "@time ", 6)) {
    int ms = -1;
    if (sscanf(command, "@time %c %d %c", &target, &ms, &extra) != 2 ||
        (target != 'd' && target != 'c' && target != 'e' && target != 'r') ||
        ms < (target == 'd' ? 0 : 100) ||
        ms > (target == 'd' ? 30000 : target == 'r' ? 3000 : 2000)) {
      calibrationReply("invalid_timing"); return;
    }
    if (servoPhase != ServoPhase::Idle) { calibrationReply("servo_busy"); return; }
    uint16_t& value = target == 'd' ? angles.callDelayMs : target == 'c' ? angles.callPressMs :
      target == 'e' ? angles.endPressMs : angles.returnMs;
    value = static_cast<uint16_t>(ms); calibrationReply(); return;
  }
  if (sscanf(command, "@set %c %c %d %c", &target, &position, &angle, &extra) != 3 ||
      (target != 'c' && target != 'e') || (position != 'r' && position != 'p') || angle < 0 || angle > 180) {
    calibrationReply("invalid_command"); return;
  }
  const bool ending = target == 'e';
  const uint8_t pin = ending ? M5_SERVO_END_PIN : M5_SERVO_CALL_PIN;
  // Finish returning the previous servo before switching to the other one.
  if (servoAttached && (servoEnding != ending || activeServoPin != pin)) {
    if (servoPhase != ServoPhase::Return) neutralServo();
    calibrationReply("returning_previous_servo"); return;
  }
  if (servoPhase != ServoPhase::Idle) { calibrationReply("servo_busy"); return; }
  servoEnding = ending; activeServoPin = pin;
  if (!servoAttached) servoAttached = ledcAttachChannel(pin, 50, 16, 6);
  if (!servoAttached) { calibrationReply("pwm_unavailable"); return; }
  if (!ledcWrite(pin, servoDuty(static_cast<unsigned>(angle)))) {
    captureMotion(ending);
    neutralServo(); calibrationReply("pwm_write_failed"); return;
  }
  commandedAngle = angle;
  uint16_t& value = ending ? (position == 'r' ? angles.endRest : angles.endPress)
                           : (position == 'r' ? angles.callRest : angles.callPress);
  value = static_cast<uint16_t>(angle);
  captureMotion(ending);
  calibrationPreviewMs = position == 'p' ? (ending ? angles.endPressMs : angles.callPressMs) : 1500;
  servoPhase = ServoPhase::Calibrating; servoAt = millis(); calibrationReply();
}
void pollReceiver(bool networkReady, bool confirmStart, bool confirmEnd) {
  pollServo(confirmStart, confirmEnd);
  if (!networkReady || (listening && boundIp != WiFi.localIP())) {
    if (clientPresent) closeClient();
    if (listening) server.end();
    listening = false; return;
  }
  if (!listening && elapsed(millis(), bindAt, 2000)) {
    bindAt = millis(); server.begin(port); server.setNoDelay(true);
    listening = static_cast<bool>(server); boundIp = WiFi.localIP();
    if (listening) Serial.printf("[STREAM] TCP %u listening\n", port);
  }
  if (!listening) return;
  if (server.hasClient()) {
    WiFiClient candidate = server.accept();
    if (calibrating || clientPresent || servoTesting || servoPhase != ServoPhase::Idle || failsafeEndPending) candidate.stop();
    else {
      client = candidate; client.setNoDelay(true); clientPresent = true;
      authenticated = false; received = txUsed = 0; headerReady = false;
      lastPacket = millis();
    }
  }
  if (!clientPresent) return;
  if (!client.connected()) { setStatus("Disconnected; audio stopped"); closeClient(); return; }
  if (!flushTx()) { fail("send_timeout"); return; }
  pumpAudio();
  if (!clientPresent) return;
  receivePackets();
  if (!clientPresent) return;
  if ((!authenticated && elapsed(millis(), lastPacket, kPartialTimeoutMs)) ||
      (received && !audio.full() && elapsed(millis(), packetAt, kPartialTimeoutMs)) ||
      elapsed(millis(), lastPacket, kIdleTimeoutMs)) fail("connection_timeout");
}
bool receiverReady() { return listening; }
bool speakerBusy() { return session.outputActive() && authenticated; }
const char* receiverStatus() { return status; }
void logReceiverStatus() {
  Serial.printf("[STREAM] TCP=%u/%s authenticated=%u queued=%u playing=%u status=%s\n",
    port, listening ? "ready" : "waiting", authenticated, static_cast<unsigned>(audio.size()),
    static_cast<unsigned>(submitted), status);
  logServoConfiguration();
  calibrationReply();
}
}  // namespace e84stream
