#include "e84_audio_app.h"
#include "e84_audio_hw.h"
#include "e84_shared.h"
#include "audio_core.h"
#include "audio_reference.h"
#include "voice_capture.h"
#include "FreeRTOS.h"
#include "task.h"
#include <limits.h>
#include <string.h>

#define CLIP_QUEUE_LENGTH 5u
#define MANUAL_RECORD_FRAMES (5u * AUDIO_RATE / AUDIO_FRAME)
#define STARTUP_FRAMES 50u
#define EVENT_MAX_AGE_MS 2000u

_Static_assert(AUDIO_FRAME == E84_AUDIO_FRAME_SAMPLES, "PDM/DSP frame mismatch");
_Static_assert(AUDIO_RATE == E84_AUDIO_SAMPLE_RATE, "PDM/DSP rate mismatch");

typedef struct {
    int16_t pcm[AUDIO_CLIP_SAMPLES];
    uint32_t samples, serial, crc;
    float score;
} queued_clip_t;

/* The linker maps this NOLOAD section to CM55 SoCMEM, away from both XIP
 * code and the small internal DTCM. initialize_audio() explicitly clears it.
 * RAM recordings survive network interruptions but are lost on reset. */
#if defined(__APPLE__)
#define AUDIO_RAM
#else
#define AUDIO_RAM __attribute__((section(".cy_socmem_bss"), aligned(32)))
#endif
static AUDIO_RAM queued_clip_t clips[CLIP_QUEUE_LENGTH];
static AUDIO_RAM audio_ring_t ring_buffer;
static audio_dsp_t dsp;
static audio_reference_matcher_t matcher;
static unsigned head, count, warmup, post_frames, wanted_frames, manual_frames;
static uint32_t serial_counter, active_serial, latest_event_serial;
static uint32_t sent_sequence, previous_capture_sequence, observed_errors;
static TickType_t latest_event_tick;
static float active_score, latest_event_score;
static bool clip_in_flight, event_pending;
static voice_capture_t voice_capture;
static bool voice_call_active;
static uint32_t voice_listen_sequence, voice_turn, voice_call_listen_baseline;

static void publish_voice_end(void)
{
    volatile e84_shared_t *shared = e84_shared();
    if (voice_capture.state != VOICE_CAPTURE_FINISHED ||
        shared->voice_end_listen_seq == voice_listen_sequence) return;
    shared->voice_end_seq = shared->voice_write_seq;
    shared->voice_end_turn = voice_turn;
    shared->voice_end_reason = (uint32_t)voice_capture.end;
    shared->voice_samples = voice_capture.emitted_frames * AUDIO_FRAME;
    e84_shared_release();
    shared->voice_end_listen_seq = voice_listen_sequence;
}

static bool publish_voice_frame(void *context, const int16_t pcm[AUDIO_FRAME])
{
    (void)context;
    volatile e84_shared_t *shared = e84_shared();
    uint32_t write = shared->voice_write_seq;
    uint32_t read = shared->voice_read_seq;
    e84_shared_acquire();
    if ((uint32_t)(write - read) >= E84_VOICE_RING_FRAMES) return false;
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        shared->voice_pcm[write % E84_VOICE_RING_FRAMES][i] = pcm[i];
    e84_shared_release();
    shared->voice_write_seq = write + 1u;
    return true;
}

static uint32_t next_serial(void)
{
    /* Never repeat a boot-seed/serial ID, including after counter exhaustion. */
    return serial_counter == UINT32_MAX ? 0u : ++serial_counter;
}

static void reset_active_capture(bool count_loss)
{
    if (count_loss && (post_frames != 0u || manual_frames != 0u))
        ++e84_shared()->dropped_clips;
    post_frames = manual_frames = 0u;
    active_serial = 0u;
    audio_reference_reset(&matcher);
}

static void initialize_audio(void)
{
    memset(clips, 0, sizeof(clips));
    memset(&ring_buffer, 0, sizeof(ring_buffer));
    audio_dsp_init(&dsp);
    audio_reference_reset(&matcher);
    head = count = post_frames = wanted_frames = manual_frames = 0u;
    serial_counter = active_serial = latest_event_serial = sent_sequence = 0u;
    previous_capture_sequence = observed_errors = 0u;
    latest_event_tick = 0u;
    active_score = latest_event_score = -1.0f;
    clip_in_flight = event_pending = false;
    voice_capture_init(&voice_capture);
    voice_call_active = false;
    voice_listen_sequence = voice_turn = voice_call_listen_baseline = 0u;
    warmup = STARTUP_FRAMES;
    volatile e84_shared_t *shared = e84_shared();
    shared->audio_status = 0u;
    shared->detected_count = shared->capture_errors = shared->capture_drops = 0u;
    shared->queued_count = shared->dropped_clips = 0u;
    shared->heartbeat = 0u;
    shared->last_score = -1.0f;
    shared->last_rms = 0.0f;
    e84_shared_release();
}

static void enqueue_clip(uint32_t wanted_samples, float score, uint32_t serial)
{
    volatile e84_shared_t *shared = e84_shared();
    if (count == CLIP_QUEUE_LENGTH || serial == 0u) {
        ++shared->dropped_clips;
        return;
    }
    queued_clip_t *clip = &clips[(head + count) % CLIP_QUEUE_LENGTH];
    clip->samples = audio_ring_copy(&ring_buffer, clip->pcm, wanted_samples);
    if (clip->samples == 0u) {
        ++shared->dropped_clips;
        return;
    }
    clip->serial = serial;
    clip->score = score;
    clip->crc = audio_crc32(clip->pcm, clip->samples * sizeof(clip->pcm[0]));
    ++count;
    shared->queued_count = count;
}

static void service_mailbox(void)
{
    volatile e84_shared_t *shared = e84_shared();
    e84_shared_acquire();
    bool call_active = shared->voice_call_active != 0u;
    if (call_active != voice_call_active) {
        reset_active_capture(false);
        ring_buffer.used = 0u;
        event_pending = false;
        voice_capture_pause(&voice_capture);
        voice_call_active = call_active;
        if (call_active) voice_call_listen_baseline = shared->voice_listen_seq;
        e84_shared_release();
        shared->voice_call_ack = call_active ? 1u : 0u;
    }
    uint32_t listen_sequence = shared->voice_listen_seq;
    e84_shared_acquire();
    bool record_enabled = shared->voice_record_enabled != 0u;
    if (voice_call_active && !record_enabled) {
        voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_CANCELLED);
        publish_voice_end();
    }
    if (voice_call_active && record_enabled && listen_sequence != 0u &&
        listen_sequence != voice_call_listen_baseline &&
        listen_sequence != shared->voice_listen_ack &&
        (voice_capture.state == VOICE_CAPTURE_IDLE || voice_capture.state == VOICE_CAPTURE_FINISHED) &&
        shared->voice_read_seq == shared->voice_write_seq) {
        /* Old PCM must have been consumed/discarded before another generation.
         * Clearing pre-roll here also excludes servo/speaker noise. */
        voice_listen_sequence = listen_sequence;
        voice_turn = shared->voice_listen_turn;
        voice_capture_listen(&voice_capture, shared->voice_rms_gate);
        shared->voice_samples = 0u;
        e84_shared_release();
        shared->voice_listen_ack = listen_sequence;
    }
    uint32_t command_sequence = shared->command_seq;
    e84_shared_acquire();
    if (command_sequence != shared->command_ack) {
        char command = (char)shared->command;
        if (command == 'e' || command == 'x') {
            /* Cancel/rearm only the active capture. Queued uploads remain. */
            reset_active_capture(false);
        } else if (command == 'r' && !voice_call_active && count < CLIP_QUEUE_LENGTH) {
            reset_active_capture(false);
            manual_frames = MANUAL_RECORD_FRAMES;
        }
        shared->command_ack = command_sequence;
    }

    if (clip_in_flight && shared->clip_ack == sent_sequence) {
        e84_shared_acquire();
        /* CM33 acknowledges only after the server acknowledges this same ID. */
        head = (head + 1u) % CLIP_QUEUE_LENGTH;
        --count;
        clip_in_flight = false;
        shared->queued_count = count;
    }
    /* Late entropy must not turn an old detection into a new physical action.
     * Recordings retain their ID serial and remain queued for later upload. */
    if (event_pending && (TickType_t)(xTaskGetTickCount() - latest_event_tick) >
        pdMS_TO_TICKS(EVENT_MAX_AGE_MS)) event_pending = false;
    if (shared->seed_ready != 0u) {
        e84_shared_acquire();
        if (event_pending) {
            ++shared->event_guard; /* odd: CM33 must retry its snapshot */
            e84_shared_release();
            for (unsigned i = 0; i < 3u; ++i) shared->event_id[i] = shared->seed[i];
            shared->event_id[3] = latest_event_serial;
            shared->event_score = latest_event_score;
            e84_shared_release();
            uint32_t event_seq = shared->event_seq + 1u;
            shared->event_seq = event_seq == 0u ? 1u : event_seq;
            e84_shared_release();
            ++shared->event_guard; /* even: event payload is complete */
            event_pending = false;
        }
        if (!clip_in_flight && count != 0u && shared->clip_seq == shared->clip_ack) {
            const queued_clip_t *clip = &clips[head];
            shared->clip_samples = clip->samples;
            for (unsigned i = 0; i < 3u; ++i) shared->clip_id[i] = shared->seed[i];
            shared->clip_id[3] = clip->serial;
            shared->clip_score = clip->score;
            shared->clip_crc = clip->crc;
            for (uint32_t i = 0; i < clip->samples; ++i) shared->clip_pcm[i] = clip->pcm[i];
            e84_shared_release();
            sent_sequence = shared->clip_seq + 1u;
            if (sent_sequence == 0u) sent_sequence = 1u;
            shared->clip_seq = sent_sequence;
            clip_in_flight = true;
        }
    }
    e84_shared_release();
}

static void process_frame(const e84_audio_frame_t *frame)
{
    volatile e84_shared_t *shared = e84_shared();
    ++shared->heartbeat;
    bool gap = (previous_capture_sequence != 0u &&
        frame->sequence != previous_capture_sequence + 1u) || frame->errors != observed_errors;
    previous_capture_sequence = frame->sequence;
    observed_errors = frame->errors;
    shared->capture_errors = frame->errors;
    shared->capture_drops = frame->drops;
    shared->audio_status = 1u;
    if (gap) {
        reset_active_capture(true);
        ring_buffer.used = 0u;
        if (voice_call_active) {
            voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_GAP);
            publish_voice_end();
        }
    }
    if (warmup != 0u) { --warmup; return; }
    if (voice_call_active) {
        /* PDM continues running so DMA stays healthy; samples are discarded
         * while the AI/M5 is speaking, never retained in either pre-roll. */
        voice_capture_feed(&voice_capture, frame->pcm, publish_voice_frame, NULL);
        shared->last_rms = voice_capture.last_rms;
        shared->voice_samples = voice_capture.emitted_frames * AUDIO_FRAME;
        publish_voice_end();
        return;
    }
    audio_ring_push(&ring_buffer, frame->pcm, AUDIO_FRAME);
    audio_feature_t feature;
    float rms = audio_feature(&dsp, frame->pcm, &feature);
    shared->last_rms = rms;
    if (manual_frames != 0u) {
        if (--manual_frames == 0u)
            enqueue_clip(5u * AUDIO_RATE, -1.0f, next_serial());
        return;
    }

    unsigned clipped = 0u, matched_frames = 0u;
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        if (frame->pcm[i] >= 32700 || frame->pcm[i] <= -32700) ++clipped;
    float distance = -1.0f;
    bool matched = audio_reference_feed(&matcher, &feature, rms, clipped, &distance, &matched_frames);
    shared->last_score = matcher.last_distance;
    if (post_frames != 0u) {
        if (--post_frames == 0u) {
            enqueue_clip(wanted_frames * AUDIO_FRAME, active_score, active_serial);
            active_serial = 0u;
        }
    } else if (matched) {
        ++shared->detected_count;
        active_serial = next_serial();
        active_score = distance;
        if (active_serial != 0u) {
            latest_event_serial = active_serial;
            latest_event_score = distance;
            latest_event_tick = xTaskGetTickCount();
            event_pending = true;
        }
        wanted_frames = AUDIO_PRE_FRAMES + matched_frames + AUDIO_POST_FRAMES;
        if (wanted_frames > AUDIO_CLIP_SAMPLES / AUDIO_FRAME)
            wanted_frames = AUDIO_CLIP_SAMPLES / AUDIO_FRAME;
        post_frames = AUDIO_POST_FRAMES;
        /* Publish the chime event immediately; recording/upload finishes later. */
        service_mailbox();
    }
}

void e84_audio_task(void *argument)
{
    (void)argument;
    initialize_audio();
    if (e84_audio_capture_start() != CY_RSLT_SUCCESS) {
        e84_shared()->audio_status = 2u;
        e84_shared_release();
        vTaskDelete(NULL);
        return;
    }
    e84_shared()->audio_status = 1u;
    e84_shared_release();
    e84_audio_frame_t frame;
    for (;;) {
        service_mailbox();
        bool have_frame = e84_audio_read(&frame, 1000u);
        /* A call can change while blocked on the PDM queue. Apply its gate
         * before processing the returned frame, including before old chime
         * detection or manual capture can run. */
        service_mailbox();
        if (have_frame) {
            process_frame(&frame);
        } else {
            reset_active_capture(true);
            ring_buffer.used = 0u;
            if (voice_call_active) {
                voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_GAP);
                publish_voice_end();
            }
            e84_shared()->audio_status = 2u;
        }
        e84_shared_release();
    }
}
