#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_core.h"

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
/* Everything below runs on the audio task. */
void audio_app_command(char command); /* e x r s l F */
void audio_app_service(void);
void audio_app_frame(const int16_t pcm[AUDIO_FRAME], bool gap);
void audio_app_no_frame(void);
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
