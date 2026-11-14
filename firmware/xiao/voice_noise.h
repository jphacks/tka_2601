#pragma once
#include "audio_core.h"
/* Audio task only. This module has no NVS/PCM logs; the separate config module
 * persists only the explicitly requested ON/OFF setting. */
typedef struct {
 uint32_t enabled,ready,active,budget_blocked,allocation_failed;
 uint32_t profiles,quiet_frames,rejected_frames,processed_frames,bypass_frames;
 uint32_t max_frame_us,over_budget_frames,profile_age_frames;
} voice_noise_status_t;
void voice_noise_init(void);
void voice_noise_clock(uint32_t (*now_us)(void));
void voice_noise_enable(bool enabled);
void voice_noise_idle(const int16_t raw[AUDIO_FRAME],bool eligible,uint32_t gate);
void voice_noise_tick(void);
bool voice_noise_begin(void);
bool voice_noise_active(void);
bool voice_noise_frame(const int16_t pcm[AUDIO_FRAME],int16_t out[AUDIO_FRAME]);
void voice_noise_end(void);
void voice_noise_gap(void);
void voice_noise_status(voice_noise_status_t *out);
