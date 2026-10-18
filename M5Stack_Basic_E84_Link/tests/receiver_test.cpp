#include "stream_receiver.h"
#include "stream_protocol.h"
#include <M5Unified.h>
#include <WiFi.h>
#include <assert.h>

int e84FakeSend(int, const void* data, size_t size, int) {
  const auto* bytes = static_cast<const uint8_t*>(data);
  fake::current->output.insert(fake::current->output.end(), bytes, bytes + size);
  return static_cast<int>(size);
}
using namespace e84stream;
namespace {
unsigned checks = 0;
const char kToken[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
#ifdef TEST_LEGACY_SERVO_CONFIG
constexpr uint32_t kCallPressDuty = 4096; // 1250 us
constexpr uint32_t kCallRestDuty = 3276;  // 1000 us, quantized at 16 bits
constexpr uint32_t kEndPressDuty = 4096;
constexpr uint32_t kEndRestDuty = 3276;
#else
constexpr uint32_t kCallPressDuty = 3276; // reversed 180 -> 0, 1000 us
constexpr uint32_t kCallRestDuty = 6553;  // reversed 0 -> 180, 2000 us
constexpr uint32_t kEndPressDuty = 3820; // opposite mounting: 30, 1166 us
constexpr uint32_t kEndRestDuty = 3276;  // opposite mounting: 0, 1000 us
#endif
void check(bool value) { ++checks; assert(value); }
void tick(uint32_t ms = 2) { fake::now += ms; pollReceiver(true, false, false); }
void enqueue(const std::shared_ptr<fake::Socket>& s, Type type, uint32_t session,
             uint32_t turn = 0, uint32_t sequence = 0, const void* data = nullptr,
             size_t length = 0) {
  Header h; h.type = type; h.session = session; h.turn = turn; h.sequence = sequence;
  h.length = length;
  uint8_t head[kHeaderBytes]; encodeHeader(h, head);
  s->input.insert(s->input.end(), head, head + sizeof(head));
  if (length) {
    const auto* bytes = static_cast<const uint8_t*>(data);
    s->input.insert(s->input.end(), bytes, bytes + length);
  }
}
std::vector<Header> replies(const std::shared_ptr<fake::Socket>& s) {
  std::vector<Header> result;
  for (size_t offset = 0; offset < s->output.size();) {
    Header h;
    check(s->output.size() - offset >= kHeaderBytes);
    check(decodeHeader(s->output.data() + offset, h));
    result.push_back(h); offset += kHeaderBytes + h.length;
  }
  s->output.clear(); return result;
}
bool saw(const std::vector<Header>& result, Type type) {
  for (const auto& r : result) if (r.type == type) return true;
  return false;
}
std::shared_ptr<fake::Socket> connect(uint32_t id) {
  auto s = std::make_shared<fake::Socket>(); fake::candidate = s;
  enqueue(s, Type::Hello, id, 0, 0, kToken, 64); tick();
  check(saw(replies(s), Type::Ready)); return s;
}
void startCall(const std::shared_ptr<fake::Socket>& s, uint32_t id) {
  enqueue(s, Type::CallStart, id); tick();
  check(fake::attachedPin == 26 && fake::servoDuties.back() == kCallPressDuty);
  check(!saw(replies(s), Type::CallStarted));
  tick(499);
  check(fake::servoDuties.back() == kCallPressDuty && !saw(replies(s), Type::CallStarted));
  tick(1); check(!saw(replies(s), Type::CallStarted));
  check(fake::attachedPin == 26 && fake::servoDuties.back() == kCallRestDuty);
  tick(499); check(fake::attachedPin == 26 && !saw(replies(s), Type::CallStarted));
  tick(1); check(fake::attachedPin == -1 && saw(replies(s), Type::CallStarted));
}
void isolatedServoDiagnostics() {
  check(fake::servoPins.empty() && !servoTestBusy()); // never moves on boot
  check(!cancelServoTest());
  const uint32_t before = millis();
  check(requestServoTest(false));
  check(millis() == before && servoTestBusy()); // nonblocking request
  check(fake::servoPins.size() == 1 && fake::attachedPin == 26);
  const uint32_t pressDuty = fake::servoDuties.back();
  check(pressDuty == kCallPressDuty);
  check(!requestServoTest(true)); // cannot overlap two servos
  auto blocked = std::make_shared<fake::Socket>(); fake::candidate = blocked;
  enqueue(blocked, Type::Hello, 90, 0, 0, kToken, 64);
  tick(499);
  check(!blocked->connected && blocked->output.empty()); // no call acknowledgements
  check(fake::servoDuties.size() == 1 && fake::attachedPin == 26);
  tick(1);
  check(servoTestBusy() && fake::servoDuties.size() == 2);
  check(fake::servoDuties.back() == kCallRestDuty); // same transform for return
  check((fake::servoDuties.back() > pressDuty) == (kCallRestDuty > kCallPressDuty));
  tick(499); check(fake::attachedPin == 26);
  tick(1);
  check(!servoTestBusy() && fake::attachedPin == -1);
  check(strcmp(receiverStatus(), "Servo test complete: call") == 0);
  tick(5000); check(fake::servoPins.size() == 1); // no follow-up end press

  check(requestServoTest(true));
  check(fake::attachedPin == 17);
  check(fake::servoDuties.back() == kEndPressDuty); // GPIO17 uses its fixed direction
  // A local diagnostic returns and detaches even while Wi-Fi is unavailable.
  fake::now += 499; pollReceiver(false, false, false);
  check(servoTestBusy() && fake::servoDuties.back() == kEndPressDuty);
  fake::now += 1; pollReceiver(false, false, false);
  check(servoTestBusy() && fake::attachedPin == 17);
  check(fake::servoDuties.back() == kEndRestDuty);
  fake::now += 499; pollReceiver(false, false, false);
  check(servoTestBusy() && fake::attachedPin == 17);
  fake::now += 1; pollReceiver(false, false, false);
  check(!servoTestBusy() && fake::attachedPin == -1);
  check(strcmp(receiverStatus(), "Servo test complete: end") == 0);

  check(requestServoTest(false)); tick(100);
  check(cancelServoTest());
  check(fake::servoDuties.back() == kCallRestDuty);
  const auto duties = fake::servoDuties.size();
  tick(450); check(cancelServoTest());
  check(fake::servoDuties.size() == duties); // repeated cancel doesn't restart return
  tick(50);
  check(!servoTestBusy() && fake::attachedPin == -1);
  check(strcmp(receiverStatus(), "Servo test cancelled: call") == 0);
  check(!cancelServoTest());

  fake::failNextServoAttach = true;
  check(!requestServoTest(false));
  check(!servoTestBusy() && fake::attachedPin == -1);
  fake::failNextServoWrite = true;
  check(!requestServoTest(false));
  check(servoTestBusy() && fake::attachedPin == 26);
  check(fake::servoDuties.back() == kCallRestDuty);
  tick(500); // partial PWM setup still returns/detaches only the selected servo
  check(!servoTestBusy() && fake::attachedPin == -1);
  check(strcmp(receiverStatus(), "Servo test cancelled: call") == 0);

  // Neither the diagnostic nor its cancellation changes call/failsafe flags.
  const auto operations = fake::servoPins.size();
  auto unauthenticated = std::make_shared<fake::Socket>(); fake::candidate = unauthenticated;
  tick(); check(!requestServoTest(false));
  unauthenticated->connected = false; tick(); tick(1000);
  check(fake::servoPins.size() == operations);
  auto s = connect(91);
  check(!requestServoTest(false) && !requestServoTest(true));
  check(s->connected && s->output.empty());
  s->connected = false; tick(); tick(1000);
  check(fake::servoPins.size() == operations);
  // Subsequent full call/playback tests below exercise normal operation again.
}
void completedPlayback() {
  auto s = connect(100);
  startCall(s, 100);
  check(fake::servoPins.back() == 26);
  const auto before = fake::servoPins.size();
  enqueue(s, Type::CallStart, 100); tick();
  check(saw(replies(s), Type::CallStarted) && fake::servoPins.size() == before);
  enqueue(s, Type::OutputStart, 100); tick();
  uint8_t pcm[640] = {};
  for (unsigned i = 0; i < 9; ++i) { pcm[0] = i; enqueue(s, Type::OutputAudio, 100, 0, i, pcm, 640); tick(); }
  check(M5.Speaker.requests.empty()); // not enough prebuffer
  pcm[0] = 9; enqueue(s, Type::OutputAudio, 100, 0, 9, pcm, 640); tick(); tick();
  check(!M5.Speaker.requests.empty());
  auto accepted = replies(s);
  check(accepted.size() == 10 && accepted.back().type == Type::AudioAck && accepted.back().sequence == 10);
  // Drain input without END: never report playback complete.
  unsigned played = 0;
  while (!M5.Speaker.requests.empty()) {
    check(M5.Speaker.requests.front().data[0] == static_cast<int16_t>(played++));
    M5.Speaker.requests.pop_front(); tick(20);
  }
  check(played == 10);
  tick(100); check(!saw(replies(s), Type::PlaybackDone));
  enqueue(s, Type::OutputEnd, 100, 0, 10); tick(); tick();
  check(!saw(replies(s), Type::PlaybackDone));
  tick(29); check(!saw(replies(s), Type::PlaybackDone));
  tick(1); check(saw(replies(s), Type::PlaybackDone));
  // API-driven TCP CALL_END uses the same fixed GPIO17 calibration and timing
  // as the isolated USB end test; acknowledge only after return and detach.
  enqueue(s, Type::CallEnd, 100); tick();
  check(fake::attachedPin == 17 && fake::servoDuties.back() == kEndPressDuty);
  check(!saw(replies(s), Type::CallEnded));
  tick(499);
  check(fake::servoDuties.back() == kEndPressDuty && !saw(replies(s), Type::CallEnded));
  tick(1);
  check(fake::attachedPin == 17 && fake::servoDuties.back() == kEndRestDuty);
  check(!saw(replies(s), Type::CallEnded));
  tick(499); check(fake::attachedPin == 17 && !saw(replies(s), Type::CallEnded));
  tick(1); check(fake::attachedPin == -1 && saw(replies(s), Type::CallEnded));
  check(fake::servoPins.back() == 17);
  const auto after = fake::servoPins.size();
  enqueue(s, Type::CallEnd, 100); tick();
  check(saw(replies(s), Type::CallEnded) && fake::servoPins.size() == after);
  s->connected = false; tick();
  // A reconnect cannot replay a previously accepted call ID.
  auto replay = std::make_shared<fake::Socket>(); fake::candidate = replay;
  enqueue(replay, Type::Hello, 100, 0, 0, kToken, 64); tick();
  check(!replay->connected && replay->output.empty());
}
void backpressureAndDisconnect() {
  auto s = connect(101); startCall(s, 101);
  enqueue(s, Type::OutputStart, 101); tick();
  uint8_t pcm[640] = {};
  for (unsigned i = 0; i < 65; ++i) enqueue(s, Type::OutputAudio, 101, 0, i, pcm, 640);
  for (unsigned i = 0; i < 40; ++i) tick();
  auto accepted = replies(s);
  check(accepted.size() == 64 && accepted.back().sequence == 64);
  check(s->input.size() - s->offset == 664); // frame65 remains in TCP
  check(M5.Speaker.requests.size() == 2);
  M5.Speaker.requests.pop_front(); tick(); tick();
  accepted = replies(s);
  check(accepted.size() == 1 && accepted[0].sequence == 65);
  const unsigned stops = M5.Speaker.ends;
  s->connected = false; tick();
  check(M5.Speaker.ends > stops && M5.Speaker.requests.empty());
  check(!saw(replies(s), Type::PlaybackDone));
  check(!requestServoTest(false)); // pending disconnect failsafe owns the servo
  tick(); tick(500); tick(500); // failed call triggers one end operation
  check(fake::servoPins.back() == 17);
}
void incompleteAndMalformed() {
  auto s = connect(102); startCall(s, 102);
  enqueue(s, Type::OutputStart, 102); tick();
  uint8_t pcm[640] = {};
  enqueue(s, Type::OutputAudio, 102, 0, 0, pcm, 640); tick();
  enqueue(s, Type::OutputEnd, 102, 0, 2); tick(); // wrong total
  check(!s->connected);
  auto result = replies(s);
  check(saw(result, Type::Error) && !saw(result, Type::PlaybackDone));
  tick(); tick(500); tick(500);
  auto partial = std::make_shared<fake::Socket>(); fake::candidate = partial;
  partial->input.push_back('D'); tick(); tick(5000);
  check(!partial->connected);
}
void shortPlaybackAndStall() {
  auto s = connect(103); startCall(s, 103);
  enqueue(s, Type::OutputStart, 103); tick();
  uint8_t pcm[2] = {0xfe, 0xff};
  enqueue(s, Type::OutputAudio, 103, 0, 0, pcm, 2); tick();
  check(M5.Speaker.requests.empty());
  enqueue(s, Type::OutputEnd, 103, 0, 1); tick(); tick();
  check(M5.Speaker.requests.size() == 1 && M5.Speaker.requests.front().count == 1);
  check(M5.Speaker.requests.front().data[0] == -2);
  M5.Speaker.requests.pop_front(); tick(); tick(30);
  check(saw(replies(s), Type::PlaybackDone));
  enqueue(s, Type::OutputStart, 103, 1); tick();
  enqueue(s, Type::OutputAudio, 103, 1, 0, pcm, 2); tick();
  enqueue(s, Type::OutputEnd, 103, 1, 1); tick(); tick();
  tick(5000); // frozen speaker must not keep the session alive indefinitely
  check(!s->connected);
  const auto result = replies(s);
  check(saw(result, Type::Error) && !saw(result, Type::PlaybackDone));
  tick(); tick(500); tick(500);
}
void acknowledgedCancellation() {
  auto s = connect(104);
  const auto before = fake::servoPins.size();
  enqueue(s, Type::Cancel, 104); tick();
  check(s->connected && saw(replies(s), Type::CallEnded));
  check(fake::servoPins.size() == before); // never started, no physical end press
  s->connected = false; tick();
  s = connect(105);
  enqueue(s, Type::CallStart, 105); tick();
  enqueue(s, Type::Cancel, 105); tick(); // abort while pressing call
  check(fake::servoDuties.back() == kCallRestDuty);
  check(!saw(replies(s), Type::CallEnded));
  tick(500); // call servo returns, then end press begins
  check(fake::servoPins.back() == 17);
  check(fake::servoDuties.back() == kEndPressDuty);
  enqueue(s, Type::Cancel, 105); tick(); // repeated cancel does not restart it
  const auto operations = fake::servoPins.size();
  tick(500); tick(500);
  check(s->connected && saw(replies(s), Type::CallEnded));
  check(fake::servoPins.size() == operations);
  enqueue(s, Type::Cancel, 105); tick();
  check(saw(replies(s), Type::CallEnded) && fake::servoPins.size() == operations);
  s->connected = false; tick();
}
void disconnectDuringCallPress() {
  auto s = connect(106);
  enqueue(s, Type::CallStart, 106); tick();
  check(fake::attachedPin == 26 && fake::servoDuties.back() == kCallPressDuty);
  s->connected = false; tick();
  check(fake::attachedPin == 26 && fake::servoDuties.back() == kCallRestDuty);
  tick(500); tick(); // call returns before the existing failsafe end operation
  check(fake::attachedPin == 17 && fake::servoDuties.back() == kEndPressDuty);
  tick(500);
  check(fake::servoDuties.back() == kEndRestDuty);
  tick(500); check(fake::attachedPin == -1);
  for (auto duty : fake::servoDuties) check(duty >= 3276 && duty <= 6553);
}
}
int main() {
  beginReceiver(8769, kToken);
  // Existing transport regressions use a short, deterministic servo cycle.
  // The separate timing tests cover the shipped defaults and delayed start.
  for (const char* cmd : {"@begin", "@time d 0", "@time c 500", "@time e 500", "@time r 500", "@save"})
    calibrationCommand(cmd);
  isolatedServoDiagnostics();
  completedPlayback(); backpressureAndDisconnect(); incompleteAndMalformed(); shortPlaybackAndStall();
  acknowledgedCancellation();
  disconnectDuringCallPress();
  printf("M5 streaming receiver: %u checks passed\n", checks);
}
