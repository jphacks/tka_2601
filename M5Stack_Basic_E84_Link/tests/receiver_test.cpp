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
  check(!saw(replies(s), Type::CallStarted));
  tick(500); check(!saw(replies(s), Type::CallStarted));
  tick(500); check(saw(replies(s), Type::CallStarted));
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
  enqueue(s, Type::CallEnd, 100); tick(); tick(500); tick(500);
  check(saw(replies(s), Type::CallEnded));
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
  check(!saw(replies(s), Type::CallEnded));
  tick(500); // call servo returns, then end press begins
  check(fake::servoPins.back() == 17);
  enqueue(s, Type::Cancel, 105); tick(); // repeated cancel does not restart it
  const auto operations = fake::servoPins.size();
  tick(500); tick(500);
  check(s->connected && saw(replies(s), Type::CallEnded));
  check(fake::servoPins.size() == operations);
  enqueue(s, Type::Cancel, 105); tick();
  check(saw(replies(s), Type::CallEnded) && fake::servoPins.size() == operations);
  s->connected = false; tick();
}
}
int main() {
  beginReceiver(8769, kToken);
  completedPlayback(); backpressureAndDisconnect(); incompleteAndMalformed(); shortPlaybackAndStall();
  acknowledgedCancellation();
  printf("M5 streaming receiver: %u checks passed\n", checks);
}
