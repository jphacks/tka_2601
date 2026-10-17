#pragma once
#include "audio_core.h"
#include <stddef.h>
#include <stdint.h>

#define E84_SHARED_MAGIC UINT32_C(0x45383431)
#define E84_VOICE_RING_FRAMES 64u /* 1.28 s; power of two makes uint32 wrap safe */

/* Single writer per field. CM33 initializes this before booting CM55. Payload
 * is immutable between clip_seq publication and clip_ack. Commands have one
 * outstanding request. Both cores use the uncached SOCMEM data alias; CM55's
 * D-cache is disabled by this application's startup before accessing it. */
typedef struct {
    uint32_t magic;
    uint32_t seed[3], seed_ready; /* CM33 boot nonce, published once */
    uint32_t command_seq, command; /* CM33 -> CM55 */
    uint32_t clip_ack;             /* CM33 -> CM55, only after server ACK */

    uint32_t command_ack;
    uint32_t audio_status; /* 0 starting, 1 capturing, 2 initialization/read failed */
    uint32_t detected_count, capture_errors, capture_drops;
    uint32_t queued_count, dropped_clips;
    float last_score, last_rms;
    uint32_t heartbeat;

    /* Latest detection; CM33 relay polls separately from slow HTTPS work.
     * Writer sets event_guard odd before changing, even after publishing. */
    uint32_t event_guard, event_seq, event_id[4];
    float event_score;

    uint32_t clip_seq, clip_samples, clip_id[4];
    float clip_score;
    uint32_t clip_crc;
    int16_t clip_pcm[AUDIO_CLIP_SAMPLES];

    /* Streaming SPSC mailbox. CM33 owns call/listen controls and read_seq;
     * CM55 owns ack, write_seq, end fields, samples and PCM. Both counters
     * are cumulative (including across calls); unsigned subtraction handles
     * wrap. Consumer copies a slot completely before publishing read_seq.
     * Producer copies PCM before publishing write_seq. No field is reset by
     * the other core. New listening requests wait for an empty ring.
     * CM33 first sets call_active and waits for matching call_ack. On activation
     * it then drains old PCM and publishes a fresh listen_seq (never reuse a
     * request from before that activation). On deactivation call_ack == 0
     * means the producer is paused and the old ring can be safely discarded.
     * CM33 writes turn/gate, enables record_enabled, releases, then publishes
     * a new listen_seq. Clearing record_enabled cancels an unfinished turn
     * while keeping call_active set, so speaker uncertainty never re-enables
     * idle chime detection or legacy recording.
     * It must send input.start first, then request listening, and may read
     * stream PCM only after the matching listen_ack.
     * End is published last in end_listen_seq; after acquiring it, CM33 must
     * drain PCM through end_seq before reporting a successful input.end.
     * Reasons: 1 silence, 2 30 s limit, 3 overflow, 4 capture gap, 5 cancel.
     * Error endings discard the whole incomplete turn on the server. */
    uint32_t voice_call_active, voice_listen_seq, voice_listen_turn, voice_record_enabled;
    uint32_t voice_rms_gate, voice_read_seq; /* gate 0 selects the default */
    uint32_t voice_call_ack, voice_listen_ack, voice_write_seq;
    uint32_t voice_end_seq, voice_end_turn, voice_end_reason;
    uint32_t voice_end_listen_seq, voice_samples;
    int16_t voice_pcm[E84_VOICE_RING_FRAMES][AUDIO_FRAME];
} e84_shared_t;

_Static_assert(sizeof(e84_shared_t) <= 256u * 1024u, "BSP shared region overflow");
_Static_assert((E84_VOICE_RING_FRAMES & (E84_VOICE_RING_FRAMES - 1u)) == 0u,
               "Ring slots must divide the uint32 counter range");
volatile e84_shared_t *e84_shared(void);
void e84_shared_acquire(void);
void e84_shared_release(void);
