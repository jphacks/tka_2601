#include "stream_protocol.h"
extern "C" {
#include "voice_protocol.h"
}
#include <assert.h>
#include <stdio.h>
#include <string.h>

using namespace e84stream;
namespace {
unsigned checks = 0;
void check(bool value) { ++checks; assert(value); }
Header packet(Type type, uint32_t turn = 0, uint32_t sequence = 0) {
  Header h; h.type = type; h.session = 0x12345678; h.turn = turn; h.sequence = sequence;
  if (type == Type::Hello) h.length = 64;
  if (type == Type::OutputAudio) h.length = 640;
  return h;
}
void headers() {
  uint8_t wire[kHeaderBytes]; Header decoded;
  Header h = packet(Type::OutputAudio, 7, 19);
  encodeHeader(h, wire);
  check(!memcmp(wire, "DVS1\x09\x00\x00\x00\x12\x34\x56\x78", 12));
  check(decodeHeader(wire, decoded));
  check(decoded.turn == 7 && decoded.sequence == 19 && decoded.length == 640);
  wire[0] = 'X'; check(!decodeHeader(wire, decoded));
  encodeHeader(h, wire); wire[6] = 1; check(!decodeHeader(wire, decoded));
  encodeHeader(h, wire); wire[5] = 1; check(!decodeHeader(wire, decoded));
  h.length = 641; encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  h.length = 0; encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  h.length = 1281; encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  h = packet(Type::Hello); encodeHeader(h, wire); check(decodeHeader(wire, decoded));
  h.length = 63; encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  h = packet(Type::CallStart); h.sequence = 1;
  encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  h = packet(Type::OutputEnd, 7, 20); h.flags = 1;
  encodeHeader(h, wire); check(decodeHeader(wire, decoded));
  h.flags = 2; encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  h = packet(Type::Ping, 7, 99); encodeHeader(h, wire); check(decodeHeader(wire, decoded));
  h.session = 0; encodeHeader(h, wire); check(!decodeHeader(wire, decoded));
  check(!decodeHeader(nullptr, decoded));
  const char token[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  check(tokenMatches(reinterpret_cast<const uint8_t*>(token), 64, token));
  check(!tokenMatches(reinterpret_cast<const uint8_t*>(token), 63, token));
  check(!tokenMatches(nullptr, 64, token));
  char wrong[65]; memcpy(wrong, token, 65); wrong[63] = '0';
  check(!tokenMatches(reinterpret_cast<const uint8_t*>(wrong), 64, token));
}
void states() {
  Session s; s.begin(0x12345678);
  check(s.accept(packet(Type::OutputStart)) == Action::Invalid);
  check(s.accept(packet(Type::CallStart)) == Action::StartCall);
  check(s.accept(packet(Type::CallStart)) == Action::Pending);
  check(s.callStarted());
  check(!s.callStarted());
  check(s.accept(packet(Type::CallStart)) == Action::Started);
  check(s.accept(packet(Type::OutputStart)) == Action::StartOutput);
  check(s.accept(packet(Type::CallEnd)) == Action::Invalid);
  check(!s.playbackFinished());
  check(s.accept(packet(Type::OutputAudio)) == Action::Audio);
  check(s.accept(packet(Type::OutputAudio)) == Action::Invalid); // duplicate PCM
  check(s.accept(packet(Type::OutputAudio, 0, 2)) == Action::Invalid); // lost frame
  check(s.accept(packet(Type::OutputEnd, 0, 0)) == Action::Invalid);
  check(s.accept(packet(Type::OutputAudio, 0, 1)) == Action::Audio);
  check(s.accept(packet(Type::OutputEnd, 0, 2)) == Action::EndOutput);
  check(s.accept(packet(Type::OutputAudio, 0, 2)) == Action::Invalid);
  check(s.outputEnded() && s.outputActive());
  check(s.playbackFinished());
  check(!s.outputActive());
  check(s.accept(packet(Type::OutputStart)) == Action::Invalid); // replay reply
  check(s.accept(packet(Type::OutputStart, 3)) == Action::StartOutput); // NO_REPLY skips
  Header ending = packet(Type::OutputEnd, 3, 0); ending.flags = 1;
  check(s.accept(ending) == Action::EndOutput); // zero samples, still explicit end
  check(s.playbackFinished());
  check(s.accept(packet(Type::OutputStart, 4)) == Action::Invalid); // final reply
  check(s.accept(packet(Type::CallEnd, 2)) == Action::Invalid);
  check(s.accept(packet(Type::CallEnd, 3)) == Action::EndCall);
  check(s.accept(packet(Type::CallEnd, 3)) == Action::Pending);
  check(s.callEnded());
  check(s.accept(packet(Type::CallEnd, 3)) == Action::Ended); // no repeated servo
  check(!s.callEnded());
  check(s.closed());
  s.begin(0x12345678);
  Header wrong = packet(Type::CallStart); wrong.session++;
  check(s.accept(wrong) == Action::Invalid);
  check(s.accept(packet(Type::Cancel, 4)) == Action::Cancel);
  check(!s.closed());
  check(s.callEnded());
  check(s.closed());
  check(s.accept(packet(Type::Ping, 4, 100)) == Action::Pong);
  check(s.accept(packet(Type::CallStart)) == Action::Invalid);
}
void buffers() {
  AudioQueue queue;
  uint8_t pcm[kAudioBytes] = {0x00, 0x80, 0xff, 0x7f, 0xff, 0xff, 0x00, 0x00};
  check(!queue.push(pcm, 1)); check(!queue.push(pcm, 641));
  check(!queue.push(nullptr, 640));
  check(queue.push(pcm, 640));
  check(queue.samples()[0] == -32768 && queue.samples()[1] == 32767 && queue.samples()[2] == -1);
  const int16_t* borrowed = queue.samples();
  for (size_t i = 1; i < kQueueFrames; ++i) check(queue.push(pcm, 640));
  check(queue.full()); check(!queue.push(pcm, 640));
  check(queue.samples() == borrowed && borrowed[0] == -32768);
  // Repeated wraparound keeps the oldest borrowed frame until explicit pop.
  for (size_t round = 0; round < kQueueFrames * 3; ++round) {
    const int16_t* next = queue.samples(1);
    queue.pop();
    check(queue.samples() == next);
    check(queue.push(pcm, 640));
  }
  queue.clear();
  check(queue.size() == 0 && queue.samples() == nullptr && queue.sampleCount() == 0);
  check(queue.push(pcm, 2) && queue.sampleCount() == 1);
  SessionHistory history;
  check(!history.contains(5)); history.remember(5); check(history.contains(5));
  for (uint32_t i = 6; i < 69; ++i) history.remember(i);
  check(history.contains(5)); history.remember(5); history.remember(69);
  check(!history.contains(5) && history.contains(69));
}
void e84Compatibility() {
  const Type kinds[] = {Type::Hello, Type::CallStart, Type::OutputStart,
    Type::OutputAudio, Type::OutputEnd, Type::CallEnd, Type::Cancel, Type::Ping};
  for (Type kind : kinds) {
    Header h = packet(kind); uint8_t wire[24];
    encodeHeader(h, wire);
    voice_header_t e84;
    check(voice_header_decode(wire, &e84));
    check(e84.type == static_cast<uint8_t>(kind) && e84.session == h.session && e84.length == h.length);
    uint8_t encoded[24]; check(voice_header_encode(encoded, &e84));
    check(!memcmp(wire, encoded, 24));
    Header m5; check(decodeHeader(encoded, m5));
    check(m5.type == h.type && m5.sequence == h.sequence && m5.turn == h.turn);
  }
}
}
int main() {
  headers(); states(); buffers(); e84Compatibility();
  printf("M5 streaming protocol: %u checks passed\n", checks);
}
