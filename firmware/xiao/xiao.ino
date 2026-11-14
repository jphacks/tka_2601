#include "console.h"
#include "flash_store.h"
#include "hw_audio.h"
#include "net_task.h"
#include "playback.h"
#include "servo_control.h"
#include "servo_probe.h"
#include "storage_worker.h"
#include "tune.h"
#include "voice_stream.h"
#include "xlog.h"
extern "C" {
#include "audio_app.h"
#include "audio_link.h"
#include "audio_upload.h"
#include "device_mode.h"
}
#include <esp_heap_caps.h>
#include <freertos/queue.h>

namespace {
QueueHandle_t audioCommands;

void audioTask(void*) {
  static int16_t pcm[AUDIO_FRAME];
  if (!hw_mic_start()) {
    xlog("[AUDIO] Microphone initialization failed.\n");
    audio_link()->audio_status = 2u;
    audio_link_release();
    vTaskDelete(nullptr);
    return;
  }
  xlog("[AUDIO] PDM capture started: 16000 Hz, signed 16-bit, mono.\n");
  for (;;) {
    char command;
    while (xQueueReceive(audioCommands, &command, 0) == pdPASS) audio_app_command(command);
    audio_app_service();
    bool gap = false;
    const bool frame = hw_mic_read(pcm, &gap);
    // A call can change while blocked on the microphone. Apply its gate first.
    audio_app_service();
    if (frame) audio_app_frame(pcm, gap);
    else audio_app_no_frame();
  }
}
void speakerTask(void*) {
  for (;;) {
    if (!playback_step(millis())) delay(2);
    else taskYIELD();
  }
}
void storageTask(void*) {
  for (;;) {
    storage_worker_step();
    delay(200);
  }
}
void startTask(TaskFunction_t task, const char* name, uint32_t stack, UBaseType_t priority, BaseType_t core) {
  if (xTaskCreatePinnedToCore(task, name, stack, nullptr, priority, nullptr, core) != pdPASS)
    xlog("[ERROR] Task %s could not start; reset required.\n", name);
}
}

extern "C" bool audio_app_post_command(char command) {
  return xQueueSend(audioCommands, &command, 0) == pdPASS;
}

void setup() {
  // A calibration response is larger than the default TX buffer.
  Serial.setTxBufferSize(2048);
  Serial.begin(115200);
  Serial.setTxTimeoutMs(20);
  xlog("[BOOT] MONBAN XIAO ESP32S3\n");
  servo_begin();
  servo_probe_begin();
  device_mode_init(); // Last good mode from NVS, before any task can see a chime.
  tune_begin();
  audioCommands = xQueueCreate(4, sizeof(char));
  auto* ring = static_cast<audio_ring_t*>(heap_caps_malloc(sizeof(audio_ring_t), MALLOC_CAP_SPIRAM));
  auto* pending = static_cast<int16_t*>(heap_caps_malloc(AUDIO_CLIP_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM));
  if (!audioCommands || !ring || !pending) {
    xlog("[ERROR] PSRAM buffers unavailable; audio disabled. Check the board's PSRAM setting.\n");
    return;
  }
  audio_app_init(ring, pending, audio_upload_configured());
  audio_flash_t flash = {};
  const bool available = flash_store_driver(&flash);
  storage_worker_begin(flash, available);
  if (!hw_speaker_init()) xlog("[ERROR] I2S speaker initialization failed.\n");
  playback_init(hw_speaker_sink());
  console_begin();
  // Real-time audio stays on core 1; Wi-Fi, TLS and flash work stay on core 0.
  startTask(speakerTask, "Speaker", 4096, 7, 1);
  startTask(audioTask, "Audio", 8192, 6, 1);
  startTask(voice_stream_task, "Call", 16384, 4, 0);
  startTask(net_task, "Network", 12288, 2, 0);
  startTask(storageTask, "Storage", 12288, 2, 0);
}

void loop() {
  console_poll();
  servo_poll();
  servo_probe_poll();
  delay(2);
}
