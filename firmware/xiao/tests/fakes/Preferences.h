#pragma once
#include <vector>
#include <cstring>
#include <map>
#include <string>
namespace fake {
inline std::vector<unsigned char> storedCalibration;
inline bool failStorage = false;
inline bool readOnlyNamespaceMissing = false;
inline std::map<std::string, std::vector<unsigned char>> preferenceRecords;
inline std::string failWriteKey, corruptReadKey, failReadKey;
inline bool failNextStorageWrite = false;
inline bool failNextStorageRead = false;
inline size_t storageWrites = 0;
}
class Preferences {
  std::string space;
  std::string recordKey(const char* key) { return space + "/" + key; }
  const std::vector<unsigned char>& bytes(const char* key) {
    // Preserve the old test fixture's direct access to the legacy single blob.
    if (!strcmp(key, "settings") && space != "monban-servo") return fake::storedCalibration;
    return fake::preferenceRecords[recordKey(key)];
  }
 public:
  bool begin(const char* name, bool readOnly) {
    space = name;
    return !fake::failStorage && !(readOnly && fake::readOnlyNamespaceMissing);
  }
  void end() {}
  uint8_t getUChar(const char* key, uint8_t fallback) {
    uint8_t value = 0;
    return getBytes(key, &value, sizeof value) == sizeof value ? value : fallback;
  }
  size_t putUChar(const char* key, uint8_t value) {
    return putBytes(key, &value, sizeof value);
  }
  size_t getBytesLength(const char* key) { return bytes(key).size(); }
  size_t getBytes(const char* key, void* out, size_t capacity) {
    if (fake::failReadKey == key) return 0;
    if (fake::failNextStorageRead) { fake::failNextStorageRead = false; return 0; }
    const auto& data = bytes(key);
    const size_t n = data.size();
    if (n > capacity) return 0;
    if (n) memcpy(out, data.data(), n);
    if (n && fake::corruptReadKey == key) { static_cast<unsigned char*>(out)[0] ^= 0xff; fake::corruptReadKey.clear(); }
    return n;
  }
  size_t putBytes(const char* key, const void* data, size_t n) {
    if (fake::failStorage || fake::failWriteKey == key) return 0;
    if (fake::failNextStorageWrite) { fake::failNextStorageWrite = false; return 0; }
    const auto* p = static_cast<const unsigned char*>(data);
    fake::preferenceRecords[recordKey(key)].assign(p, p + n);
    if (strcmp(key, "shared-op")) fake::storedCalibration.assign(p, p + n);
    ++fake::storageWrites;
    return n;
  }
};
