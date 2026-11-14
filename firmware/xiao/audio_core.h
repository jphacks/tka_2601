#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AUDIO_RATE 16000u
#define AUDIO_FRAME 320u /* 20 ms */
#define AUDIO_BANDS 16u
#define AUDIO_MAX_FRAMES 200u /* longest matched sound in a clip: 4 seconds */
#define AUDIO_TEMPLATE_FRAMES 150u /* registered sound: at most 3 seconds */
#define AUDIO_TEMPLATE_MIN_FRAMES 10u /* 0.2 seconds */
#define AUDIO_PRE_FRAMES 50u
#define AUDIO_POST_FRAMES 50u
#define AUDIO_CLIP_SAMPLES ((AUDIO_MAX_FRAMES + AUDIO_PRE_FRAMES + AUDIO_POST_FRAMES) * AUDIO_FRAME)
/* 2: one template with pitch, from a single ring (chime_detector.c).
 * 1 (three mel-only templates) is rejected on load: register again. */
#define AUDIO_MODEL_VERSION 2u
#define AUDIO_THRESHOLD_MIN 0.02f
#define AUDIO_THRESHOLD_MAX 0.40f
#define AUDIO_GATE_MAX 16000.0f
#define AUDIO_CENT_MAX 7500 /* cents above 55 Hz; 4000 Hz is about 7420 */

typedef struct { int8_t band[AUDIO_BANDS]; } audio_feature_t;
/* One 20 ms frame of the registered sound or of the microphone. Frames below
 * the gate have mel, cent and tonal all zero. */
typedef struct {
    audio_feature_t mel;
    int16_t cent;  /* strongest 300-4000 Hz peak, cents above 55 Hz */
    uint8_t tonal; /* 1: the strongest peak holds a large share of the 200-6000 Hz power */
    uint8_t loud;  /* 1: RMS at or above the gate */
    uint8_t onset; /* 1: loud, and 6 dB above the quieter of the two frames before */
} audio_frame_t;
typedef struct {
    uint32_t version, length;
    float gate_rms, threshold;
    audio_frame_t frame[AUDIO_TEMPLATE_FRAMES];
} audio_model_t;

/* One owner/task per context. No allocator or platform dependencies. */
typedef struct {
    float real[512], imag[512], window[AUDIO_FRAME];
    float weight[AUDIO_BANDS][257];
} audio_dsp_t;
void audio_dsp_init(audio_dsp_t *dsp);
/* Returns the frame RMS. Leaves the power spectrum in dsp->real[0..256]. */
float audio_feature(audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME], audio_feature_t *out);
/* After audio_feature(): the strongest 300-4000 Hz peak of the same frame
 * (parabolic interpolation, in cents above 55 Hz). Returns the share of the
 * 200-6000 Hz power within one bin of it, 0..1. */
float audio_pitch(const audio_dsp_t *dsp, int16_t *cent);
bool audio_model_valid(const audio_model_t *model);
uint32_t audio_crc32(const void *data, size_t length);
void audio_wav_header(uint8_t header[44], uint32_t samples);

typedef struct {
    int16_t pcm[AUDIO_CLIP_SAMPLES];
    uint32_t write, used;
} audio_ring_t;
void audio_ring_push(audio_ring_t *ring, const int16_t *pcm, uint32_t samples);
/* Copies the newest samples, in chronological order; returns actual count. */
uint32_t audio_ring_copy(const audio_ring_t *ring, int16_t *out, uint32_t samples);
