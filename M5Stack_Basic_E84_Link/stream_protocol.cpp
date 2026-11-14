#include "stream_protocol.h"
#include "link_protocol.h"
#include <string.h>

namespace e84stream {
namespace {
uint32_t read32(const uint8_t* p) {
  return (static_cast<uint32_t>(p[0]) << 24) |
         (static_cast<uint32_t>(p[1]) << 16) |
         (static_cast<uint32_t>(p[2]) << 8) | p[3];
}
void write32(uint8_t* p, uint32_t v) {
  p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}
}
bool decodeHeader(const uint8_t* bytes, Header& h) {
  if (!bytes || memcmp(bytes, "DVS1", 4) || bytes[6] || bytes[7]) return false;
  Header value;
  value.type = static_cast<Type>(bytes[4]); value.flags = bytes[5];
  value.session = read32(bytes + 8); value.turn = read32(bytes + 12);
  value.sequence = read32(bytes + 16); value.length = read32(bytes + 20);
  if (!value.session || bytes[4] < 1 || bytes[4] > 20 || value.length > kMaxPayload)
    return false;
  if (value.flags && !((value.type == Type::InputEnd || value.type == Type::OutputEnd)
                       && value.flags == 1)) return false;
  switch (value.type) {
    case Type::Hello:
      if (value.turn || value.sequence || value.length != 64) return false;
      break;
    case Type::InputAudio: case Type::OutputAudio:
      if (value.length < 2 || value.length > kAudioBytes || value.length % 2) return false;
      break;
    case Type::Error:
      if (!value.length || value.sequence) return false;
      break;
    default:
      if (value.length) return false;
      if (value.type != Type::InputEnd && value.type != Type::OutputEnd &&
          value.type != Type::PlaybackDone && value.type != Type::AudioAck &&
          value.type != Type::Ping && value.type != Type::Pong && value.sequence)
        return false;
  }
  h = value;
  return true;
}
void encodeHeader(const Header& h, uint8_t* bytes) {
  memcpy(bytes, "DVS1", 4); bytes[4] = static_cast<uint8_t>(h.type);
  bytes[5] = h.flags; bytes[6] = bytes[7] = 0;
  write32(bytes + 8, h.session); write32(bytes + 12, h.turn);
  write32(bytes + 16, h.sequence); write32(bytes + 20, h.length);
}
bool tokenMatches(const uint8_t* payload, size_t length, const char* expected) {
  if (!payload || length != 64 || !e84link::validToken(expected)) return false;
  uint8_t difference = 0;
  for (size_t i = 0; i < 64; ++i) difference |= payload[i] ^ expected[i];
  return difference == 0;
}
bool AudioQueue::push(const uint8_t* pcm, size_t bytes) {
  if (!pcm || full() || bytes < 2 || bytes > kAudioBytes || bytes % 2) return false;
  Frame& frame = frames_[(head_ + size_) % kQueueFrames];
  for (size_t i = 0; i < bytes / 2; ++i)
    frame.pcm[i] = static_cast<int16_t>(static_cast<uint16_t>(pcm[i * 2]) |
                    (static_cast<uint16_t>(pcm[i * 2 + 1]) << 8));
  frame.samples = bytes / 2;
  ++size_;
  return true;
}
const int16_t* AudioQueue::samples(size_t offset) const {
  return offset < size_ ? frames_[(head_ + offset) % kQueueFrames].pcm : nullptr;
}
size_t AudioQueue::sampleCount(size_t offset) const {
  return offset < size_ ? frames_[(head_ + offset) % kQueueFrames].samples : 0;
}
void AudioQueue::pop() {
  if (size_) { head_ = (head_ + 1) % kQueueFrames; --size_; }
}
void AudioQueue::clear() { head_ = size_ = 0; }

void Session::begin(uint32_t session) { *this = Session{}; id_ = session; }
Action Session::accept(const Header& h) {
  if (h.session != id_) return Action::Invalid;
  if (h.type == Type::Ping) return Action::Pong;
  if (h.type == Type::Cancel && h.turn >= turn_) {
    if (phase_ == Phase::Ended) return Action::Ended;
    turn_ = h.turn; phase_ = Phase::Ending; return Action::Cancel;
  }
  if (h.type == Type::CallStart && h.turn == 0) {
    if (started_) return Action::Started;
    if (phase_ == Phase::Starting) return Action::Pending;
    if (phase_ != Phase::Initial) return Action::Invalid;
    phase_ = Phase::Starting; return Action::StartCall;
  }
  if (h.type == Type::CallEnd && h.turn >= turn_) {
    if (phase_ == Phase::Ended) return Action::Ended;
    if (phase_ == Phase::Ending) return Action::Pending;
    if (phase_ != Phase::Idle) return Action::Invalid;
    turn_ = h.turn; phase_ = Phase::Ending; return Action::EndCall;
  }
  if (h.type == Type::OutputStart) {
    if (phase_ != Phase::Idle || endRequested_ || (hasOutput_ && h.turn <= turn_))
      return Action::Invalid;
    turn_ = h.turn; frames_ = 0; outputEnded_ = false; hasOutput_ = true;
    phase_ = Phase::Output; return Action::StartOutput;
  }
  if (phase_ != Phase::Output || h.turn != turn_ || outputEnded_)
    return Action::Invalid;
  if (h.type == Type::OutputAudio && h.sequence == frames_ && frames_ < 3000) {
    ++frames_; return Action::Audio;
  }
  if (h.type == Type::OutputEnd && h.sequence == frames_) {
    outputEnded_ = true; endRequested_ = h.flags & 1; return Action::EndOutput;
  }
  return Action::Invalid;
}
bool Session::callStarted() {
  if (phase_ != Phase::Starting) return false;
  started_ = true; phase_ = Phase::Idle; return true;
}
bool Session::playbackFinished() {
  if (phase_ != Phase::Output || !outputEnded_) return false;
  phase_ = Phase::Idle; return true;
}
bool Session::callEnded() {
  if (phase_ != Phase::Ending) return false;
  phase_ = Phase::Ended; return true;
}
bool SessionHistory::contains(uint32_t session) const {
  for (uint32_t id : ids_) if (id == session) return true;
  return false;
}
void SessionHistory::remember(uint32_t session) {
  if (session && !contains(session)) { ids_[next_] = session; next_ = (next_ + 1) % 64; }
}
}  // namespace e84stream
