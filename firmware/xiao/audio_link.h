#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_core.h"

#define AUDIO_LINK_RING_FRAMES 64u /* 1.28 s; power of two makes uint32 wrap safe */

/* Audio task <-> call task mailbox. Single writer per field.
 * The call task owns call/listen controls and voice_read_seq; the audio task
 * owns acks, voice_write_seq, end fields, samples and PCM. Both counters are
 * cumulative; unsigned subtraction handles wrap. New listening requests wait
 * for an empty ring.
 * The call task first sets call_active and waits for the matching call_ack. It
 * writes turn/gate, enables record_enabled, releases, then publishes a new
 * listen_seq; clearing record_enabled cancels an unfinished turn. It must send
 * input_start first and may read PCM only after the matching listen_ack.
 * End is published last in end_listen_seq; after acquiring it, the call task
 * must drain PCM through end_seq before reporting a successful input_end.
 * Reasons: 1 silence, 2 30 s limit, 3 overflow, 4 capture gap, 5 cancel. */
typedef struct {
    uint32_t audio_status; /* 0 starting, 1 capturing, 2 initialization/read failed */
    uint32_t detected_count, capture_errors;
    float last_score, last_rms; /* last_rms covers every frame, for the level meter */
    uint32_t heartbeat;
    int32_t pcm_min, pcm_max;
    uint32_t event_seq; /* chime detections; one writer, read once per poll */
    uint32_t loopback_samples, loopback_failed; /* audio task -> call task; failed: 1 busy, 2 microphone */

    uint32_t voice_call_active, voice_listen_seq, voice_listen_turn, voice_record_enabled;
    uint32_t voice_rms_gate, voice_read_seq;
    uint32_t voice_call_ack, voice_listen_ack, voice_write_seq;
    uint32_t voice_end_seq, voice_end_turn, voice_end_reason;
    uint32_t voice_end_listen_seq, voice_samples;
    int16_t voice_pcm[AUDIO_LINK_RING_FRAMES][AUDIO_FRAME];
} audio_link_t;

#ifndef __cplusplus
_Static_assert((AUDIO_LINK_RING_FRAMES & (AUDIO_LINK_RING_FRAMES - 1u)) == 0u,
               "Ring slots must divide the uint32 counter range");
#endif
bool audio_link_init(void);
volatile audio_link_t *audio_link(void);
void audio_link_acquire(void);
void audio_link_release(void);
#ifdef __cplusplus
}
#endif
