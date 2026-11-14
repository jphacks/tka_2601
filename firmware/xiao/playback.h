#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PLAYBACK_QUEUE_FRAMES 64u
#define PLAYBACK_PREBUFFER_FRAMES 32u
/* The API may have another 16 unacknowledged frames in flight: 48+16 <= 64. */
#define PLAYBACK_CREDIT_FRAMES 48u
#define PLAYBACK_FRAME_SAMPLES 320u

/* The speaker task runs playback_step; the call task uses everything else. */
typedef struct {
    bool (*start)(void);
    /* One frame, or false if it could not be accepted in time. */
    bool (*write)(const int16_t *pcm, size_t samples);
    void (*stop)(void);
    uint32_t drain_ms; /* time for written PCM to leave the DMA buffers */
} playback_sink_t;

void playback_init(const playback_sink_t *sink);
bool playback_open(uint32_t now_ms);
bool playback_push(const uint8_t *pcm, size_t bytes, uint32_t now_ms);
void playback_finish(void);
bool playback_full(void);
/* Frames the server may count as accepted; returned only as PCM is released. */
uint32_t playback_credit(void);
/* Queue, speaker writes and DMA drain are all complete. */
bool playback_done(void);
/* When the speaker started for the current response (ms clock), 0 until it has. */
uint32_t playback_started_ms(void);
/* Static reason once playback has failed, otherwise NULL. */
const char *playback_error(void);
/* Discard everything. playback_idle turns true once the speaker task let go. */
void playback_abort(void);
bool playback_idle(void);
/* Returns true if it made progress; otherwise the speaker task may sleep. */
bool playback_step(uint32_t now_ms);
#ifdef __cplusplus
}
#endif
