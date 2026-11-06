#include <Preferences.h>
#include <cassert>
#include <cstdio>
extern "C" {
#include "device_mode.h"
}

// The NVS record is two bytes, the mode and its complement. Anything else is
// "nothing stored", so a damaged record can never turn into a mode.
int main() {
  uint8_t value = 0;
  assert(!device_mode_store_read(&value));  // never stored
  for (uint8_t mode = DEVICE_MODE_NORMAL; mode <= DEVICE_MODE_OFF; ++mode) {
    assert(device_mode_store_write(mode));
    value = 0;
    assert(device_mode_store_read(&value) && value == mode);
    const auto& raw = fake::preferenceRecords["monban-mode/mode"];
    assert(raw.size() == 2 && raw[0] == mode && raw[1] == static_cast<uint8_t>(~mode));
  }
  assert(!device_mode_store_write(0) && !device_mode_store_write(5) && !device_mode_store_write(255));
  assert(device_mode_store_read(&value) && value == DEVICE_MODE_OFF);  // rejected writes changed nothing
  // Damaged records: bad complement, bad range, bad length.
  auto& raw = fake::preferenceRecords["monban-mode/mode"];
  raw = {DEVICE_MODE_OFF, DEVICE_MODE_OFF};
  value = 0; assert(!device_mode_store_read(&value) && value == 0);
  raw = {0, 0xff}; assert(!device_mode_store_read(&value));
  raw = {5, static_cast<uint8_t>(~5)}; assert(!device_mode_store_read(&value));
  raw = {DEVICE_MODE_OFF}; assert(!device_mode_store_read(&value));
  raw = {DEVICE_MODE_OFF, 0xff - DEVICE_MODE_OFF, 0}; assert(!device_mode_store_read(&value));
  // Storage failures are reported, not hidden.
  fake::failStorage = true;
  assert(!device_mode_store_write(DEVICE_MODE_AWAY) && !device_mode_store_read(&value));
  fake::failStorage = false;
  fake::failNextStorageWrite = true;
  assert(!device_mode_store_write(DEVICE_MODE_AWAY));
  fake::corruptReadKey = "mode";  // readback differs from what was written
  assert(!device_mode_store_write(DEVICE_MODE_AWAY));
  fake::corruptReadKey.clear();
  fake::readOnlyNamespaceMissing = true;
  assert(!device_mode_store_read(&value));  // first boot: namespace does not exist yet
  fake::readOnlyNamespaceMissing = false;
  assert(device_mode_store_write(DEVICE_MODE_NORMAL) && device_mode_store_read(&value) && value == DEVICE_MODE_NORMAL);
  std::puts("device mode store: passed");
  return 0;
}
