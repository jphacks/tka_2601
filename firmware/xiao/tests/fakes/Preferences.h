#pragma once
#include <vector>
#include <cstring>
namespace fake {
inline std::vector<unsigned char> storedCalibration;
inline bool failStorage = false;
}
class Preferences {
 public:
  bool begin(const char*, bool) { return !fake::failStorage; }
  void end() {}
  size_t getBytesLength(const char*) { return fake::storedCalibration.size(); }
  size_t getBytes(const char*, void* out, size_t capacity) {
    const size_t n = fake::storedCalibration.size();
    if (n > capacity) return 0;
    memcpy(out, fake::storedCalibration.data(), n); return n;
  }
  size_t putBytes(const char*, const void* data, size_t n) {
    if (fake::failStorage) return 0;
    const auto* p = static_cast<const unsigned char*>(data);
    fake::storedCalibration.assign(p, p + n); return n;
  }
};
