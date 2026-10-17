#pragma once
#include <algorithm>
#include <memory>
#include <vector>
#include <stdint.h>
#include <string.h>
struct IPAddress {
  uint32_t value;
  IPAddress(uint32_t v = 0) : value(v) {}
  bool operator!=(IPAddress other) const { return value != other.value; }
};
namespace fake {
struct Socket {
  bool connected = true;
  std::vector<uint8_t> input, output;
  size_t offset = 0;
};
inline std::shared_ptr<Socket> candidate, current;
}
class WiFiClient {
  std::shared_ptr<fake::Socket> socket;
 public:
  WiFiClient() = default;
  WiFiClient(std::shared_ptr<fake::Socket> s) : socket(s) {}
  void stop() { if (socket) socket->connected = false; }
  void setNoDelay(bool) {}
  bool connected() { return socket && socket->connected; }
  int fd() { fake::current = socket; return 42; }
  int available() { return socket ? socket->input.size() - socket->offset : 0; }
  int read(uint8_t* data, size_t length) {
    const size_t count = std::min(length, static_cast<size_t>(available()));
    memcpy(data, socket->input.data() + socket->offset, count); socket->offset += count;
    return count;
  }
};
class WiFiServer {
  bool started = false;
 public:
  WiFiServer(uint16_t, uint8_t) {}
  void begin(uint16_t) { started = true; }
  void setNoDelay(bool) {}
  void end() { started = false; }
  bool hasClient() { return fake::candidate != nullptr; }
  WiFiClient accept() { auto s = fake::candidate; fake::candidate.reset(); return WiFiClient(s); }
  explicit operator bool() const { return started; }
};
struct WiFiFake { IPAddress localIP() { return IPAddress(123); } };
inline WiFiFake WiFi;
