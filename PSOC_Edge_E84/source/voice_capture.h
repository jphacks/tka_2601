#ifndef VOICE_CAPTURE_H
#define VOICE_CAPTURE_H

#include "audio_core.h"
#include <stdbool.h>
#include <stdint.h>

/* Speech endpointing uses PCM RMS, not a trained speech classifier. Tune the
 * gate for the actual microphone/intercom installation. Limits include the
 * pre-roll and trailing silence, so no turn exceeds 30 seconds on the wire. */
#define VOICE_CAPTURE_MAX_FRAMES (30u * AUDIO_RATE / AUDIO_FRAME)
#define VOICE_CAPTURE_SILENCE_FRAMES (1200u * AUDIO_RATE / (1000u * AUDIO_FRAME))
#define VOICE_CAPTURE_PREROLL_FRAMES 10u
#define VOICE_CAPTURE_START_FRAMES 3u
#define VOICE_CAPTURE_DEFAULT_RMS 600u

typedef enum {
    VOICE_CAPTURE_IDLE = 0,
    VOICE_CAPTURE_LISTENING,
    VOICE_CAPTURE_SPEECH,
    VOICE_CAPTURE_FINISHED
} voice_capture_state_t;

typedef enum {
    VOICE_CAPTURE_END_NONE = 0,
    VOICE_CAPTURE_END_SILENCE,
    VOICE_CAPTURE_END_LIMIT,
    VOICE_CAPTURE_END_OVERFLOW,
    VOICE_CAPTURE_END_GAP,
    VOICE_CAPTURE_END_CANCELLED
} voice_capture_end_t;

/* The sink must copy one complete frame before returning true. A false return
 * aborts the turn; missing samples must never become a successful utterance. */
typedef bool (*voice_capture_sink_t)(void *context, const int16_t pcm[AUDIO_FRAME]);

typedef struct {
    int16_t preroll[VOICE_CAPTURE_PREROLL_FRAMES][AUDIO_FRAME];
    uint32_t pre_write, pre_used, start_frames, silent_frames, emitted_frames;
    uint32_t rms_gate;
    float last_rms;
    voice_capture_state_t state;
    voice_capture_end_t end;
} voice_capture_t;

void voice_capture_init(voice_capture_t *capture);
void voice_capture_listen(voice_capture_t *capture, uint32_t rms_gate);
void voice_capture_pause(voice_capture_t *capture);
void voice_capture_abort(voice_capture_t *capture, voice_capture_end_t reason);
void voice_capture_feed(voice_capture_t *capture, const int16_t pcm[AUDIO_FRAME],
                        voice_capture_sink_t sink, void *context);

#endif
