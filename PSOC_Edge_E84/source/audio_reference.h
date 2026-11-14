#pragma once
#include "audio_core.h"

typedef struct {
    audio_feature_t history[AUDIO_MAX_FRAMES];
    float rms[AUDIO_MAX_FRAMES];
    uint16_t clipped[AUDIO_MAX_FRAMES];
    audio_pattern_t trial;
    unsigned write, used, stride, cooldown;
    float last_distance;
} audio_reference_matcher_t;

const char *audio_reference_name(void);
unsigned audio_reference_frames(void);
float audio_reference_threshold(void);
void audio_reference_reset(audio_reference_matcher_t *matcher);
/* Sliding whole-sound comparison; silence gaps never split the reference.
 * Returns a match once, then suppresses overlapping matches for two seconds. */
bool audio_reference_feed(audio_reference_matcher_t *matcher, const audio_feature_t *feature,
                          float rms, unsigned clipped_samples, float *distance, unsigned *matched_frames);
