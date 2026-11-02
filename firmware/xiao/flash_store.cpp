extern "C" {
#include "flash_store.h"
}
#include <Arduino.h>
#include <esp_partition.h>

namespace {
const esp_partition_t* partition = nullptr;
constexpr size_t kSector = 4096;

bool inRange(uint32_t offset, size_t length) {
  return offset <= AUDIO_STORE_BYTES && length <= AUDIO_STORE_BYTES - offset;
}
bool flashRead(uint32_t offset, void* out, size_t length) {
  return inRange(offset, length) && esp_partition_read(partition, offset, out, length) == ESP_OK;
}
bool flashWrite(uint32_t offset, const void* data, size_t length) {
  return inRange(offset, length) && esp_partition_write(partition, offset, data, length) == ESP_OK;
}
bool flashErase(uint32_t offset, size_t length) {
  if (!inRange(offset, length) || offset % kSector || length % kSector) return false;
  // Sector at a time: the microphone DMA covers one sector erase, not a 64 KiB block.
  for (size_t done = 0; done < length; done += kSector) {
    if (esp_partition_erase_range(partition, offset + done, kSector) != ESP_OK) return false;
    delay(1);
  }
  return true;
}
}

extern "C" bool flash_store_driver(audio_flash_t* driver) {
  partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, static_cast<esp_partition_subtype_t>(0x40), "audio_store");
  if (!partition || partition->size < AUDIO_STORE_BYTES) return false;
  driver->read = flashRead;
  driver->write = flashWrite;
  driver->erase = flashErase;
  return true;
}
