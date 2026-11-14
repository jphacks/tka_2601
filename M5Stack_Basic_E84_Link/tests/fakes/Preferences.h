#pragma once
#include <vector>
#include <cstring>
namespace fake {
inline std::vector<unsigned char> storedCalibration;
inline std::vector<unsigned char> storedLegacy;
inline bool failStorage = false;
}
class Preferences {
 public:
  bool begin(const char*, bool) { return !fake::failStorage; }
  void end() {}
  const std::vector<unsigned char>& bytes(const char* key) { return !strcmp(key,"angles") ? fake::storedLegacy : fake::storedCalibration; }
  size_t getBytesLength(const char* key) { return bytes(key).size(); }
  size_t getBytes(const char* key, void* out, size_t capacity) {
    const auto& data = bytes(key);
    const size_t n = data.size();
    if (n > capacity) return 0;
    memcpy(out, data.data(), n); return n;
  }
  size_t putBytes(const char*, const void* data, size_t n) {
    if (fake::failStorage) return 0;
    const auto* p = static_cast<const unsigned char*>(data);
    fake::storedCalibration.assign(p, p + n); return n;
  }
};
