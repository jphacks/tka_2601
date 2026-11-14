#include "playback.h"
#include "xlog.h"
#include <stdatomic.h>
#include <string.h>
#if defined(ARDUINO_ARCH_ESP32) || defined(ESP_PLATFORM)
#include <esp_heap_caps.h>
#endif

#define OUTPUT_TIMEOUT_MS 15000u
#define PROGRESS_TIMEOUT_MS 5000u

typedef enum { IDLE, BUFFERING, PLAYING, DRAINING, DONE, FAILED } state_t;
typedef struct { int16_t pcm[PLAYBACK_FRAME_SAMPLES]; uint16_t samples; } frame_t;

static const playback_sink_t *sink;
#if defined(ARDUINO_ARCH_ESP32) || defined(ESP_PLATFORM)
/* CPU-side queue: hw_audio copies each frame into its own I2S write buffer. */
static frame_t *frames;
#else
static frame_t host_frames[PLAYBACK_QUEUE_FRAMES];
static frame_t *frames = host_frames;
#endif
static atomic_uint state, write_seq, read_seq, last_output_ms, started_ms;
static atomic_bool finished, abort_requested;
static const char *_Atomic failure;
static bool sink_started;
static uint32_t progress_ms, drain_at_ms;

void playback_init(const playback_sink_t *value)
{
    sink = value;
#if defined(ARDUINO_ARCH_ESP32) || defined(ESP_PLATFORM)
    /* Called once during setup, before speaker/call tasks can access the queue. */
    if (!frames) frames = heap_caps_calloc(PLAYBACK_QUEUE_FRAMES, sizeof(*frames), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!frames) {
        sink = NULL;
        atomic_store(&failure, "playback_psram_allocation_failed");
        atomic_store(&state, FAILED);
        xlog("[STREAM] playback_psram_allocation_failed: bytes=%lu\n",
             (unsigned long)(PLAYBACK_QUEUE_FRAMES * sizeof(*frames)));
        return;
    }
#endif
    atomic_store(&failure, NULL);
    atomic_store(&state, IDLE);
}
static bool terminal(unsigned value) { return value == IDLE || value == DONE || value == FAILED; }
bool playback_idle(void) { return terminal(atomic_load(&state)); }
bool playback_open(uint32_t now_ms)
{
    if (!frames || !sink || !playback_idle()) return false;
    atomic_store(&write_seq, 0u); atomic_store(&read_seq, 0u); atomic_store(&started_ms, 0u);
    atomic_store(&finished, false); atomic_store(&abort_requested, false);
    atomic_store(&failure, NULL);
    atomic_store(&last_output_ms, now_ms);
    progress_ms = now_ms;
    atomic_store(&state, BUFFERING);
    return true;
}
bool playback_full(void)
{
    return atomic_load(&write_seq) - atomic_load(&read_seq) >= PLAYBACK_QUEUE_FRAMES;
}
bool playback_push(const uint8_t *pcm, size_t bytes, uint32_t now_ms)
{
    unsigned value = atomic_load(&state);
    if (terminal(value) || atomic_load(&finished) || !bytes || bytes > sizeof(frames[0].pcm) ||
        (bytes & 1u) || playback_full()) return false;
    unsigned write = atomic_load(&write_seq);
    frame_t *frame = &frames[write % PLAYBACK_QUEUE_FRAMES];
    memcpy(frame->pcm, pcm, bytes);
    frame->samples = (uint16_t)(bytes / 2u);
    atomic_store(&last_output_ms, now_ms);
    atomic_store(&write_seq, write + 1u);
    return true;
}
void playback_finish(void) { atomic_store(&finished, true); }
uint32_t playback_credit(void)
{
    unsigned write = atomic_load(&write_seq), credit = atomic_load(&read_seq) + PLAYBACK_CREDIT_FRAMES;
    return write < credit ? write : credit;
}
bool playback_done(void) { return atomic_load(&state) == DONE; }
uint32_t playback_started_ms(void) { return atomic_load(&started_ms); }
const char *playback_error(void) { return atomic_load(&failure); }
void playback_abort(void) { atomic_store(&abort_requested, true); }

static void close_sink(void)
{
    if (sink_started) sink->stop();
    sink_started = false;
}
static bool fail(const char *reason)
{
    close_sink();
    xlog("[STREAM] %s\n", reason);
    atomic_store(&failure, reason);
    atomic_store(&state, FAILED);
    return true;
}
bool playback_step(uint32_t now_ms)
{
    unsigned value = atomic_load(&state);
    if (terminal(value)) return false;
    if (atomic_load(&abort_requested)) {
        close_sink();
        atomic_store(&state, IDLE);
        return true;
    }
    unsigned read = atomic_load(&read_seq);
    unsigned available = atomic_load(&write_seq) - read;
    bool ended = atomic_load(&finished);
    /* An underrun/EOF is never completion. Resume when data returns, or abort. */
    /* Signed: the call task can store a time just after the caller read the clock. */
    if (!ended && (int32_t)(now_ms - atomic_load(&last_output_ms)) >= (int32_t)OUTPUT_TIMEOUT_MS)
        return fail("audio_progress_timeout");
    switch (value) {
    case BUFFERING:
        if (available < PLAYBACK_PREBUFFER_FRAMES && !ended) return false;
        if (!sink_started) {
            if (!sink->start()) return fail("speaker_start_failed");
            sink_started = true;
            /* 0 means "not yet", so a start at exactly 0 ms is reported as 1 ms. */
            atomic_store(&started_ms, now_ms ? now_ms : 1u);
        }
        progress_ms = now_ms;
        atomic_store(&state, PLAYING);
        return true;
    case PLAYING:
        if (available) {
            const frame_t *frame = &frames[read % PLAYBACK_QUEUE_FRAMES];
            if (!sink->write(frame->pcm, frame->samples)) {
                if ((uint32_t)(now_ms - progress_ms) >= PROGRESS_TIMEOUT_MS)
                    return fail("speaker_progress_timeout");
                return false;
            }
            progress_ms = now_ms;
            atomic_store(&read_seq, read + 1u);
            return true;
        }
        if (ended) { drain_at_ms = now_ms; atomic_store(&state, DRAINING); return true; }
        atomic_store(&state, BUFFERING);
        return true;
    case DRAINING:
        if ((uint32_t)(now_ms - drain_at_ms) < sink->drain_ms) return false;
        close_sink();
        atomic_store(&state, DONE);
        return true;
    default:
        return false;
    }
}
