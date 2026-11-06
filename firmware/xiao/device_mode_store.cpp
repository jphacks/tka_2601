extern "C" {
#include "device_mode.h"
}
#include <Preferences.h>

namespace {
// Two bytes: the mode and its complement, so a torn or foreign value is rejected.
constexpr const char* kSpace = "monban-mode";
constexpr const char* kKey = "mode";
}

extern "C" bool device_mode_store_read(uint8_t* value) {
  Preferences prefs;
  if (!prefs.begin(kSpace, true)) return false;
  uint8_t bytes[2] = {0, 0};
  const bool ok = prefs.getBytesLength(kKey) == sizeof(bytes) && prefs.getBytes(kKey, bytes, sizeof(bytes)) == sizeof(bytes) &&
    static_cast<uint8_t>(bytes[0] ^ bytes[1]) == 0xff && bytes[0] >= DEVICE_MODE_NORMAL && bytes[0] <= DEVICE_MODE_OFF;
  prefs.end();
  if (ok) *value = bytes[0];
  return ok;
}
extern "C" bool device_mode_store_write(uint8_t value) {
  if (value < DEVICE_MODE_NORMAL || value > DEVICE_MODE_OFF) return false;
  Preferences prefs;
  if (!prefs.begin(kSpace, false)) return false;
  const uint8_t bytes[2] = {value, static_cast<uint8_t>(~value)};
  uint8_t verified[2] = {0, 0};
  const bool ok = prefs.putBytes(kKey, bytes, sizeof(bytes)) == sizeof(bytes) &&
    prefs.getBytesLength(kKey) == sizeof(bytes) && prefs.getBytes(kKey, verified, sizeof(verified)) == sizeof(verified) &&
    verified[0] == bytes[0] && verified[1] == bytes[1];
  prefs.end();
  return ok;
}
