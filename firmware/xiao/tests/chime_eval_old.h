#pragma once
/* The detector on main before the one-ring registration (audio_core.c and
 * audio_app.c at d47c3c9), kept only so tests/chime_eval.c can compare.
 * Same features (audio_feature), a gate, a 0.5 s end of sound, and DTW
 * against three templates. Not used by the firmware. */
#include "audio_core.h"

#define OLD_MAX_FRAMES 200u
#define OLD_END_FRAMES 25u
#define OLD_TEMPLATES 3u
typedef struct {
    uint32_t length;
    audio_feature_t frame[OLD_MAX_FRAMES + OLD_END_FRAMES];
} old_pattern_t;
typedef struct {
    uint32_t count;
    float gate_rms, threshold;
    old_pattern_t pattern[OLD_TEMPLATES];
} old_model_t;
typedef enum { OLD_NORMAL, OLD_NOISE, OLD_ENROLL, OLD_VERIFY } old_mode_t;
typedef struct {
    old_model_t model, enrolling;
    old_pattern_t candidate;
    old_mode_t mode;
    bool valid;
    unsigned noise_frames, quiet, clipped, reject_until_quiet;
    float noise_sum, last_score;
} old_detector_t;

float old_distance(const old_pattern_t *a, const old_pattern_t *b);
/* Starts registration: 5 s of background, three rings, one verification ring. */
void old_begin_enroll(old_detector_t *d);
/* One frame. Returns true on a detection (NORMAL with a valid model). */
bool old_push(old_detector_t *d, audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME]);
