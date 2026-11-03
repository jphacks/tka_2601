#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AUDIO_RATE 16000u
#define AUDIO_FRAME 320u /* 20 ms */
#define AUDIO_BANDS 16u
#define AUDIO_MAX_FRAMES 200u /* one registered sound: at most 4 seconds */
#define AUDIO_END_FRAMES 25u /* wait 0.5 s to find the sound's end */
#define AUDIO_TEMPLATES 3u
#define AUDIO_PRE_FRAMES 50u
#define AUDIO_POST_FRAMES 50u
#define AUDIO_CLIP_SAMPLES ((AUDIO_MAX_FRAMES + AUDIO_PRE_FRAMES + AUDIO_POST_FRAMES) * AUDIO_FRAME)
#define AUDIO_MODEL_VERSION 1u

typedef struct { int8_t band[AUDIO_BANDS]; } audio_feature_t;
typedef struct {
    uint32_t length;
    audio_feature_t frame[AUDIO_MAX_FRAMES + AUDIO_END_FRAMES];
} audio_pattern_t;
typedef struct {
    uint32_t version, count;
    float gate_rms, threshold;
    audio_pattern_t pattern[AUDIO_TEMPLATES];
} audio_model_t;

/* One owner/task per context. No allocator or platform dependencies. */
typedef struct {
    float real[512], imag[512], window[AUDIO_FRAME];
    float weight[AUDIO_BANDS][257];
} audio_dsp_t;
void audio_dsp_init(audio_dsp_t *dsp);
float audio_feature(audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME], audio_feature_t *out);
/* Length-constrained, band-limited DTW; lower is closer, 0 is identical. */
float audio_distance(const audio_pattern_t *a, const audio_pattern_t *b);
float audio_match(const audio_model_t *model, const audio_pattern_t *candidate);
bool audio_model_valid(const audio_model_t *model);
bool audio_calibrate(audio_model_t *model);
uint32_t audio_crc32(const void *data, size_t length);
void audio_wav_header(uint8_t header[44], uint32_t samples);

typedef struct {
    int16_t pcm[AUDIO_CLIP_SAMPLES];
    uint32_t write, used;
} audio_ring_t;
void audio_ring_push(audio_ring_t *ring, const int16_t *pcm, uint32_t samples);
/* Copies the newest samples, in chronological order; returns actual count. */
uint32_t audio_ring_copy(const audio_ring_t *ring, int16_t *out, uint32_t samples);
