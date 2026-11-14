#pragma once

#include <stddef.h>
#include <stdint.h>

namespace e84link {

constexpr size_t kMaxPacketBytes = 512;
constexpr size_t kReplayCapacity = 64;
constexpr uint32_t kReplayTtlMs = 10u * 60u * 1000u;

enum class Kind : uint8_t { Ping, Chime };
struct Message {
  Kind kind;
  char eventId[33];
  double score;
};

bool validToken(const char* token);
// Only the documented v1 schema is accepted; output is unchanged on failure.
bool parseMessage(const char* data, size_t length, const char* expectedToken,
                  Message& output);
// Returns bytes excluding NUL; the reply uses the E84 canonical field order.
size_t formatPong(char* output, size_t capacity, const char* eventId,
                  const char* token);

class ReplayCache {
 public:
  // Call only after authentication. Duplicate packets do not extend the TTL.
  bool markUnique(const Message& message, uint32_t now);

 private:
  struct Entry {
    char eventId[33] = {};
    uint32_t acceptedAt = 0;
    Kind kind = Kind::Ping;
    bool occupied = false;
  };
  Entry entries_[kReplayCapacity] = {};
};

}  // namespace e84link
