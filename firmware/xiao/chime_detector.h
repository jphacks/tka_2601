#pragma once
/* Chime registration from one ring, and streaming detection of that chime.
 * Pure C: no allocator, no platform calls. Each context belongs to one task.
 * Design: docs/specs/chime-detection/design.md. */
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_core.h"

/* Constants marked "eval" were chosen with tests/chime_eval.c (run.sh eval);
 * the reasons are in the design document. Each may be overridden with -D for
 * a parameter sweep, never in the firmware build. */
#define CHIME_ENROLL_GATE_FACTOR 4.0f /* registration: gate = background x this (design) */
#ifndef CHIME_GATE_FACTOR
#define CHIME_GATE_FACTOR 2.0f /* eval: detection gate = tracked floor x this */
#endif
#define CHIME_GATE_MIN 80.0f
#ifndef CHIME_TONAL_SHARE
#define CHIME_TONAL_SHARE 0.30f /* eval: peak share of 200-6000 Hz power */
#endif
#ifndef CHIME_PITCH_WEIGHT
#define CHIME_PITCH_WEIGHT 0.3f /* eval: wp */
#endif
#ifndef CHIME_ONSET_WEIGHT
#define CHIME_ONSET_WEIGHT 3.0f /* eval: one frame starts a note, the other does not */
#endif
#ifndef CHIME_THRESHOLD_K
#define CHIME_THRESHOLD_K 1.0f /* eval */
#endif
#ifndef CHIME_THRESHOLD_C
#define CHIME_THRESHOLD_C 0.22f /* eval */
#endif
#ifndef CHIME_THRESHOLD_LOW
#define CHIME_THRESHOLD_LOW 0.15f /* eval */
#endif
#ifndef CHIME_THRESHOLD_HIGH
#define CHIME_THRESHOLD_HIGH 0.30f /* eval; at most AUDIO_THRESHOLD_MAX */
#endif
#define CHIME_NOISE_FRAMES 100u      /* 2 s of background before the ring */
#define CHIME_END_FRAMES 25u         /* 0.5 s below the gate ends the registered sound */
#define CHIME_LONG_FRAMES 200u       /* past 4 s the first 3 s become the template */
#define CHIME_PRE_FRAMES 25u         /* PCM before the onset, used for the variants */
#define CHIME_REFRACTORY_FRAMES 150u /* 3 s without a second detection */
#define CHIME_LOUD_COVER 0.8f        /* loud template frames paired with loud frames */
#define CHIME_VARIANTS 5u
/* Analysis frames per call of chime_enroll_work(): one feature + one DTW
 * column each, about 8 x 0.5 ms on the ESP32-S3 (estimate; chime_detector.c). */
#define CHIME_WORK_FRAMES 8u

/* --- Streaming detection (SPRING: subsequence DTW updated once per frame). */
typedef struct {
    float cost;      /* accumulated, symmetric weights */
    uint32_t start;  /* detector frame where this alignment begins */
    uint16_t weight; /* 2 per diagonal step, 1 per other step: the score divisor */
    uint8_t hits;    /* loud template frames paired with a loud frame so far */
    uint8_t hit;     /* this template frame is already counted */
} chime_cell_t;
typedef struct {
    const audio_model_t *model;
    chime_cell_t column[2][AUDIO_TEMPLATE_FRAMES];
    uint32_t frame;
    float floor, best, history[2];
    uint16_t template_loud, loud_run, quiet_run, refractory;
    uint8_t current, sounding;
} chime_detector_t;
typedef enum {
    CHIME_NONE,
    CHIME_DETECTED,  /* the whole template matched; score and frames are set */
    CHIME_SOUND_END, /* a sound ended without detection; score is its best */
} chime_event_t;
typedef struct {
    float score;     /* accumulated cost / path weight; lower is closer */
    uint32_t frames; /* matched length, for the clip */
} chime_result_t;

void chime_detector_init(chime_detector_t *d, const audio_model_t *model);
/* Drops every partial match (capture gap, call). Keeps the noise floor. */
void chime_detector_reset(chime_detector_t *d);
float chime_detector_gate(const chime_detector_t *d);
/* limit: the enrolled threshold scaled by the margin; negative never detects. */
chime_event_t chime_detector_push(chime_detector_t *d, audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME],
                                  float limit, chime_result_t *out);
/* Lowest end score of any allowed alignment this frame (FLT_MAX if none). */
float chime_detector_last_score(const chime_detector_t *d);

/* --- Registration from one ring. */
typedef enum {
    CHIME_ENROLL_IDLE, CHIME_ENROLL_NOISE, CHIME_ENROLL_LISTEN, CHIME_ENROLL_SOUND,
    CHIME_ENROLL_WAIT_PCM, CHIME_ENROLL_ANALYZE, CHIME_ENROLL_DONE, CHIME_ENROLL_FAILED,
} chime_enroll_phase_t;
typedef enum {
    CHIME_REASON_NONE,
    CHIME_REASON_NOISY,       /* background too loud to set a gate */
    CHIME_REASON_SHORT,       /* sound under 0.2 s: ring again */
    CHIME_REASON_CLIPPED,     /* over 1% of samples clipped: ring again */
    CHIME_REASON_NO_PCM,      /* the recording was not available */
    CHIME_REASON_UNSTABLE,    /* the sound does not match its own variants */
    CHIME_REASON_NOISE_MATCH, /* the background already matches the sound */
} chime_reason_t;
typedef enum {
    CHIME_ENROLL_EV_NONE,
    CHIME_ENROLL_EV_NOISE_DONE, /* gate set; ask for the ring */
    CHIME_ENROLL_EV_RETRY,      /* reason SHORT or CLIPPED; still listening */
    CHIME_ENROLL_EV_NEED_PCM,   /* call chime_enroll_set_pcm() with the newest samples */
    CHIME_ENROLL_EV_DONE,       /* model is ready to use and save */
    CHIME_ENROLL_EV_FAILED,
} chime_enroll_event_t;
typedef struct {
    chime_enroll_phase_t phase;
    chime_reason_t reason;
    unsigned frames, length, quiet, captured;
    uint32_t clipped;
    float history[2], noise_sum, floor, gate, worst, noise_score, variant_score[CHIME_VARIANTS];
    float noise_rms[CHIME_NOISE_FRAMES];
    audio_frame_t noise[CHIME_NOISE_FRAMES];
    audio_frame_t sound[CHIME_LONG_FRAMES];
    const int16_t *pcm;
    uint32_t pcm_samples, onset, seed;
    unsigned variant, position;
    chime_detector_t detector;
    audio_model_t model;
} chime_enroll_t;

void chime_enroll_begin(chime_enroll_t *e);
/* During NOISE, LISTEN and SOUND: one microphone frame. */
chime_enroll_event_t chime_enroll_push(chime_enroll_t *e, audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME]);
/* After EV_NEED_PCM: how many of the newest samples to pass. */
uint32_t chime_enroll_pcm_samples(const chime_enroll_t *e);
/* The newest samples, oldest first. The buffer must stay unchanged until DONE/FAILED. */
chime_enroll_event_t chime_enroll_set_pcm(chime_enroll_t *e, const int16_t *pcm, uint32_t samples);
/* During ANALYZE: up to `frames` analysis frames of work. */
chime_enroll_event_t chime_enroll_work(chime_enroll_t *e, audio_dsp_t *dsp, unsigned frames);
/* Host tools: a whole recording (background first, then the ring) in one call. */
chime_enroll_event_t chime_enroll_from_pcm(chime_enroll_t *e, audio_dsp_t *dsp, const int16_t *pcm, uint32_t samples);
const char *chime_reason_text(chime_reason_t reason);
#ifdef __cplusplus
}
#endif
