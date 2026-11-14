#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "playback.h"
#include <stdbool.h>
#include <stdint.h>

/* PDM microphone on I2S0 (the only PDM receiver on the ESP32-S3), MAX98357A on I2S1. */
bool hw_mic_start(void);
/* Blocks for one 20 ms frame. false on timeout; *gap reports lost samples. */
bool hw_mic_read(int16_t *pcm, bool *gap);
bool hw_speaker_init(void);
const playback_sink_t *hw_speaker_sink(void);
#ifdef __cplusplus
}
#endif
