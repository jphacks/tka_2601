#include "stream_receiver.h"
#include "stream_protocol.h"
#include <M5Unified.h>
#include <WiFi.h>
#include <lwip/sockets.h>
#include <errno.h>

#if __has_include("servo_config.h")
#include "servo_config.h"
#else
#include "servo_config.example.h"
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
enum class ServoPhase { Idle, Press, Return, Manual };
ServoPhase servoPhase = ServoPhase::Idle;
bool servoEnding = false, servoAttached = false;
bool callAttempted = false, endAttempted = false, failsafeEndPending = false;
bool callActionRequested = false, cancelRequested = false;
uint32_t servoAt = 0;
uint8_t activeServoPin = M5_SERVO_CALL_PIN;

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
  if (servoAttached) {
    // Keep the return pulse active for the configured return interval even
    // after a socket disconnect, then detach in pollServo().
    ledcWrite(activeServoPin, servoDuty(M5_SERVO_REST_DEG));
    servoPhase = ServoPhase::Return; servoAt = millis();
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
    (M5_SERVO_CALL_PIN == 26 || M5_SERVO_CALL_PIN == 16 || M5_SERVO_CALL_PIN == 17) &&
    (M5_SERVO_END_PIN == 26 || M5_SERVO_END_PIN == 16 || M5_SERVO_END_PIN == 17) &&
    M5_SERVO_MIN_US >= 500 && M5_SERVO_MIN_US < M5_SERVO_MAX_US && M5_SERVO_MAX_US <= 2500 &&
    M5_SERVO_REST_DEG >= 0 && M5_SERVO_REST_DEG <= 180 &&
    M5_SERVO_PRESS_DEG >= 0 && M5_SERVO_PRESS_DEG <= 180 &&
    M5_SERVO_PRESS_MS >= 100 && M5_SERVO_PRESS_MS <= 3000 &&
    M5_SERVO_RETURN_MS >= 100 && M5_SERVO_RETURN_MS <= 3000;
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
  if (ending) endAttempted = true;
  activeServoPin = ending ? M5_SERVO_END_PIN : M5_SERVO_CALL_PIN;
  // Explicit channel 6 avoids the LCD backlight's LEDC channel.
  servoAttached = ledcAttachChannel(activeServoPin, 50, 16, 6);
  if (!servoAttached) { fail("servo_pwm_failed"); return false; }
  if (!ledcWrite(activeServoPin, servoDuty(M5_SERVO_PRESS_DEG))) {
    fail("servo_pwm_failed"); return false;
  }
  if (!ending) callAttempted = true;
  servoPhase = ServoPhase::Press;
  setStatus(ending ? "Pressing end button" : "Pressing call button");
  return true;
}
void completeServo() {
  servoPhase = ServoPhase::Idle;
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
  if (servoPhase == ServoPhase::Idle && failsafeEndPending) {
    failsafeEndPending = false;
    startServo(true);
  }
  if (servoPhase == ServoPhase::Manual) {
    if (servoEnding ? confirmEnd : confirmStart) completeServo();
    else if (elapsed(millis(), servoAt, 60000)) fail("manual_confirmation_timeout");
  } else if (servoPhase == ServoPhase::Press && elapsed(millis(), servoAt, M5_SERVO_PRESS_MS)) {
    neutralServo();
  } else if (servoPhase == ServoPhase::Return && elapsed(millis(), servoAt, M5_SERVO_RETURN_MS)) {
    ledcDetach(activeServoPin); servoAttached = false;
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
  Serial.printf("[STREAM] TCP port=%u PCM=16000/16bit/mono servo=%s\n", port,
    M5_SERVO_ENABLED ? "enabled" : (M5_SERVO_MANUAL_TEST ? "MANUAL TEST" : "disabled"));
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
    if (clientPresent || servoPhase != ServoPhase::Idle || failsafeEndPending) candidate.stop();
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
}
}  // namespace e84stream
