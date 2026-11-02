#include "hw_audio.h"
#include "board_pins.h"
#include "tune.h"
#include "xlog.h"
extern "C" {
#include "audio_core.h"
}
#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/i2s_pdm.h>
#include <driver/i2s_std.h>
#include <esp_attr.h>

namespace {
// 16 kHz with DSR_16S gives a 2.048 MHz PDM clock, inside the LMD3526's
// 1.3-4.8 MHz standard range. The default DSR_8S (1.024 MHz) is outside it.
constexpr uint32_t kMicDmaFrames = AUDIO_FRAME;
constexpr uint32_t kMicDmaDesc = 8;       // 160 ms, longer than one flash sector erase
constexpr uint32_t kSpeakerDmaFrames = AUDIO_FRAME;
constexpr uint32_t kSpeakerDmaDesc = 6;   // 120 ms
i2s_chan_handle_t micChannel = nullptr, speakerChannel = nullptr;
volatile uint32_t micOverflows = 0;
uint32_t observedOverflows = 0;

IRAM_ATTR bool onMicOverflow(i2s_chan_handle_t, i2s_event_data_t*, void*) {
  micOverflows = micOverflows + 1;
  return false;
}
bool ampEnable(bool on) {
  // Released (not driven) lets R8 hold SD_MODE near 0.45 V: (L+R)/2 mono, per
  // hardware/xiao_bff/README.md. LOW shuts the amplifier down.
  const auto pin = static_cast<gpio_num_t>(PIN_AMP_SD_MODE);
  if (on) return gpio_set_direction(pin, GPIO_MODE_INPUT) == ESP_OK;
  return gpio_set_level(pin, 0) == ESP_OK && gpio_set_direction(pin, GPIO_MODE_OUTPUT) == ESP_OK;
}
bool speakerStart() {
  if (i2s_channel_enable(speakerChannel) != ESP_OK) return false;
  if (!ampEnable(true)) { i2s_channel_disable(speakerChannel); return false; }
  return true;
}
bool speakerWrite(const int16_t* pcm, size_t samples) {
  int16_t scaled[AUDIO_FRAME];
  const int32_t volume = static_cast<int32_t>(tune_speaker_volume());
  for (size_t i = 0; i < samples; ++i) scaled[i] = static_cast<int16_t>(pcm[i] * volume / 100);
  size_t written = 0;
  const esp_err_t result = i2s_channel_write(speakerChannel, scaled, samples * sizeof(int16_t), &written, 100);
  return result == ESP_OK && written == samples * sizeof(int16_t);
}
void speakerStop() {
  ampEnable(false);
  i2s_channel_disable(speakerChannel);
}
const playback_sink_t kSink = {speakerStart, speakerWrite, speakerStop,
  kSpeakerDmaDesc * kSpeakerDmaFrames * 1000u / AUDIO_RATE + 10u};
}

extern "C" {
bool hw_mic_start(void) {
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel.dma_desc_num = kMicDmaDesc;
  channel.dma_frame_num = kMicDmaFrames;
  if (i2s_new_channel(&channel, nullptr, &micChannel) != ESP_OK) return false;
  i2s_pdm_rx_config_t config = {};
  config.clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(AUDIO_RATE);
  config.clk_cfg.dn_sample_mode = I2S_PDM_DSR_16S;
  config.slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  config.slot_cfg.slot_mask = I2S_PDM_SLOT_LEFT; // L/R pin is tied to GND
  config.gpio_cfg.clk = static_cast<gpio_num_t>(PIN_MIC_CLK);
  config.gpio_cfg.din = static_cast<gpio_num_t>(PIN_MIC_DATA);
  if (i2s_channel_init_pdm_rx_mode(micChannel, &config) != ESP_OK) return false;
  i2s_event_callbacks_t callbacks = {};
  callbacks.on_recv_q_ovf = onMicOverflow;
  if (i2s_channel_register_event_callback(micChannel, &callbacks, nullptr) != ESP_OK) return false;
  return i2s_channel_enable(micChannel) == ESP_OK;
}
bool hw_mic_read(int16_t *pcm, bool *gap) {
  size_t got = 0;
  const esp_err_t result = i2s_channel_read(micChannel, pcm, AUDIO_FRAME * sizeof(int16_t), &got, 1000);
  const uint32_t overflows = micOverflows;
  *gap = overflows != observedOverflows;
  observedOverflows = overflows;
  return result == ESP_OK && got == AUDIO_FRAME * sizeof(int16_t);
}
bool hw_speaker_init(void) {
  const auto sd = static_cast<gpio_num_t>(PIN_AMP_SD_MODE);
  gpio_reset_pin(sd);
  gpio_set_pull_mode(sd, GPIO_FLOATING);
  if (!ampEnable(false)) return false;
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
  channel.dma_desc_num = kSpeakerDmaDesc;
  channel.dma_frame_num = kSpeakerDmaFrames;
  channel.auto_clear = true; // underruns send silence, not stale PCM
  if (i2s_new_channel(&channel, &speakerChannel, nullptr) != ESP_OK) return false;
  i2s_std_config_t config = {};
  config.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_RATE);
  config.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  config.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH; // same sample in L and R for the (L+R)/2 mix
  config.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  config.gpio_cfg.bclk = static_cast<gpio_num_t>(PIN_AMP_BCLK);
  config.gpio_cfg.ws = static_cast<gpio_num_t>(PIN_AMP_LRCLK);
  config.gpio_cfg.dout = static_cast<gpio_num_t>(PIN_AMP_DIN);
  config.gpio_cfg.din = I2S_GPIO_UNUSED;
  return i2s_channel_init_std_mode(speakerChannel, &config) == ESP_OK;
}
const playback_sink_t *hw_speaker_sink(void) { return &kSink; }
}
