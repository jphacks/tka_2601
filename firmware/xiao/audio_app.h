#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_core.h"
#include "chime_detector.h"

/* Work the storage task performs for the audio task. A flag is set by the audio
 * task and cleared by the storage task once the work is finished. */
typedef struct {
    volatile bool formatting, model_busy, clip_busy, clip_saving;
    audio_model_t model_to_save;
    int16_t *pending_pcm;
    volatile uint32_t pending_samples;
    volatile float pending_score;
} audio_jobs_t;
extern audio_jobs_t audio_jobs;

/* ring and pending hold AUDIO_CLIP_SAMPLES each. record_clips false means no
 * recording ever reaches flash (nowhere configured to send it). */
void audio_app_init(audio_ring_t *ring, int16_t *pending, bool record_clips);
/* Before the audio task starts: the model loaded from flash. */
audio_model_t *audio_app_model(void);
/* Chime registration, for a future app request as well as the console's e/x.
 * Start and cancel queue the command for the audio task (false: queue full).
 * Status is readable from any task. SAVING turns into DONE once the storage
 * task has written the model; the model is already active while it saves. */
typedef enum {
    AUDIO_ENROLL_IDLE,
    AUDIO_ENROLL_NOISE,     /* 2 s of background */
    AUDIO_ENROLL_LISTEN,    /* waiting for the one ring */
    AUDIO_ENROLL_ANALYZE,   /* checking the recorded ring, about 3 s */
    AUDIO_ENROLL_SAVING,
    AUDIO_ENROLL_DONE,
    AUDIO_ENROLL_FAILED,    /* reason says why; NONE for a call or a capture gap */
    AUDIO_ENROLL_CANCELLED,
} audio_enroll_phase_t;
typedef struct {
    audio_enroll_phase_t phase;
    chime_reason_t reason; /* LISTEN: the last retry (SHORT/CLIPPED); FAILED: the cause */
} audio_enroll_status_t;
bool audio_app_enroll_start(void);
bool audio_app_enroll_cancel(void);
audio_enroll_status_t audio_app_enroll_status(void);
/* Everything below runs on the audio task. */
void audio_app_command(char command); /* e x r s l F */
void audio_app_service(void);
void audio_app_frame(const int16_t pcm[AUDIO_FRAME], bool gap);
void audio_app_no_frame(void);
/* Optional voice-only noise frontend; raw chime input is never modified.
 * The clock measures real CPU work on ESP32; a null clock is host-test only. */
void audio_app_noise_clock(uint32_t (*clock_us)(void));
void audio_app_noise_background(const int16_t raw[AUDIO_FRAME],bool externally_idle);
/* Any task: registered model state, for status output. */
bool audio_app_model_valid(void);
float audio_app_threshold(void);
float audio_app_gate(void);
/* Call task, after playing the samples published in audio_link()->loopback_samples. */
void audio_app_loopback_release(void);
/* Any task: queue a command for the audio task; false if the queue is full. */
bool audio_app_post_command(char command);
/* Provided by the storage worker. */
bool audio_storage_ready(void);
#ifdef __cplusplus
}
#endif
