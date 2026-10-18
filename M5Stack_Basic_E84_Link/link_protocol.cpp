#include "link_protocol.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace e84link {
namespace {
bool hexString(const char* text, size_t length) {
  if (!text || strlen(text) != length) return false;
  for (size_t i = 0; i < length; ++i) {
    if (!((text[i] >= '0' && text[i] <= '9') ||
          (text[i] >= 'a' && text[i] <= 'f'))) return false;
  }
  return true;
}

class Cursor {
 public:
  Cursor(const char* data, size_t size) : data_(data), size_(size) {}

  void whitespace() {
    while (position_ < size_ &&
           (data_[position_] == ' ' || data_[position_] == '\t' ||
            data_[position_] == '\r' || data_[position_] == '\n')) ++position_;
  }
  bool consume(char ch) {
    whitespace();
    if (position_ == size_ || data_[position_] != ch) return false;
    ++position_;
    return true;
  }
  bool finished() {
    whitespace();
    return position_ == size_;
  }
  bool string(char* result, size_t capacity) {
    if (!consume('"')) return false;
    size_t count = 0;
    while (position_ < size_) {
      const unsigned char ch = static_cast<unsigned char>(data_[position_++]);
      if (ch == '"') {
        result[count] = '\0';
        return true;
      }
      // Protocol strings contain ASCII without JSON escapes.
      if (ch < 0x20 || ch >= 0x7f || ch == '\\' || count + 1 >= capacity)
        return false;
      result[count++] = static_cast<char>(ch);
    }
    return false;
  }
  bool number(double& result) {
    whitespace();
    const size_t start = position_;
    if (position_ < size_ && data_[position_] == '-') ++position_;
    if (position_ == size_) return false;
    if (data_[position_] == '0') {
      ++position_;
    } else {
      if (data_[position_] < '1' || data_[position_] > '9') return false;
      while (position_ < size_ && digit(data_[position_])) ++position_;
    }
    if (position_ < size_ && data_[position_] == '.') {
      ++position_;
      if (position_ == size_ || !digit(data_[position_])) return false;
      while (position_ < size_ && digit(data_[position_])) ++position_;
    }
    if (position_ < size_ && (data_[position_] == 'e' || data_[position_] == 'E')) {
      ++position_;
      if (position_ < size_ && (data_[position_] == '+' || data_[position_] == '-'))
        ++position_;
      if (position_ == size_ || !digit(data_[position_])) return false;
      while (position_ < size_ && digit(data_[position_])) ++position_;
    }
    const size_t length = position_ - start;
    if (length >= 64) return false;
    char number[64];
    memcpy(number, data_ + start, length);
    number[length] = '\0';
    result = strtod(number, nullptr);
    return isfinite(result);
  }

 private:
  static bool digit(char ch) { return ch >= '0' && ch <= '9'; }
  const char* data_;
  size_t size_;
  size_t position_ = 0;
};
}  // namespace

bool validToken(const char* token) { return hexString(token, 64); }

bool parseMessage(const char* data, size_t length, const char* expectedToken,
                  Message& output) {
  if (!data || length == 0 || length > kMaxPacketBytes ||
      !validToken(expectedToken)) return false;
  Cursor input(data, length);
  if (!input.consume('{')) return false;
  Message candidate{};
  char token[65] = {};
  unsigned fields = 0;
  for (unsigned count = 0; count < 5; ++count) {
    char name[16];
    if (!input.string(name, sizeof(name)) || !input.consume(':')) return false;
    unsigned field;
    if (!strcmp(name, "v")) {
      field = 1;
      // Accept exactly the integer 1, not 1.0 or an exponent.
      if (!input.consume('1')) return false;
    } else if (!strcmp(name, "type")) {
      field = 2;
      char type[8];
      if (!input.string(type, sizeof(type))) return false;
      if (!strcmp(type, "ping")) candidate.kind = Kind::Ping;
      else if (!strcmp(type, "chime")) candidate.kind = Kind::Chime;
      else return false;
    } else if (!strcmp(name, "event_id")) {
      field = 4;
      if (!input.string(candidate.eventId, sizeof(candidate.eventId)) ||
          !hexString(candidate.eventId, 32)) return false;
    } else if (!strcmp(name, "token")) {
      field = 8;
      if (!input.string(token, sizeof(token)) || !validToken(token)) return false;
    } else if (!strcmp(name, "score")) {
      field = 16;
      if (!input.number(candidate.score) ||
          (candidate.score < 0 && candidate.score != -1)) return false;
    } else {
      return false;
    }
    if (fields & field) return false;
    fields |= field;
    if (input.consume('}')) {
      if (!input.finished()) return false;
      const unsigned required = candidate.kind == Kind::Ping ? 15 : 31;
      if (fields != required) return false;
      unsigned difference = 0;
      for (size_t i = 0; i < 64; ++i)
        difference |= static_cast<unsigned char>(token[i] ^ expectedToken[i]);
      if (difference) return false;
      output = candidate;
      return true;
    }
    if (!input.consume(',')) return false;
  }
  return false;
}

size_t formatPong(char* output, size_t capacity, const char* eventId,
                  const char* token) {
  if (!output || capacity == 0) return 0;
  output[0] = '\0';
  if (!hexString(eventId, 32) || !validToken(token)) return 0;
  const int length = snprintf(output, capacity,
      "{\"v\":1,\"type\":\"pong\",\"event_id\":\"%s\",\"token\":\"%s\"}",
      eventId, token);
  if (length <= 0 || static_cast<size_t>(length) >= capacity) {
    output[0] = '\0';
    return 0;
  }
  return static_cast<size_t>(length);
}

bool ReplayCache::markUnique(const Message& message, uint32_t now) {
  size_t replacement = 0;
  uint32_t oldestAge = 0;
  bool haveFree = false;
  for (size_t i = 0; i < kReplayCapacity; ++i) {
    Entry& entry = entries_[i];
    const uint32_t age = now - entry.acceptedAt;
    if (!entry.occupied || age >= kReplayTtlMs) {
      if (!haveFree) replacement = i;
      haveFree = true;
    } else {
      if (entry.kind == message.kind && !strcmp(entry.eventId, message.eventId))
        return false;
      if (!haveFree && age >= oldestAge) {
        replacement = i;
        oldestAge = age;
      }
    }
  }
  Entry& entry = entries_[replacement];
  memcpy(entry.eventId, message.eventId, sizeof(entry.eventId));
  entry.kind = message.kind;
  entry.acceptedAt = now;
  entry.occupied = true;
  return true;
}
}  // namespace e84link
