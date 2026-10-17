#include "voice_capture.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static voice_capture_t capture;
static unsigned frames, accepted_limit;
static int16_t starts[VOICE_CAPTURE_MAX_FRAMES];

static bool sink(void *context, const int16_t pcm[AUDIO_FRAME])
{
    assert(context == &capture);
    if (frames == accepted_limit) return false;
    assert(frames < VOICE_CAPTURE_MAX_FRAMES);
    starts[frames++] = pcm[0];
    return true;
}

static void feed(int16_t value, unsigned count)
{
    int16_t pcm[AUDIO_FRAME];
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = value;
    while (count--) voice_capture_feed(&capture, pcm, sink, &capture);
}

static void reset(void)
{
    voice_capture_init(&capture);
    frames = 0u;
    accepted_limit = VOICE_CAPTURE_MAX_FRAMES;
    memset(starts, 0, sizeof(starts));
    voice_capture_listen(&capture, 600u);
}

static void silence_and_preroll(void)
{
    reset();
    feed(0, 2000u); /* No empty turn even after 30 seconds without speech. */
    assert(frames == 0u && capture.state == VOICE_CAPTURE_LISTENING);
    feed(800, 2u);
    feed(0, 1u); /* A brief impulse does not activate recording. */
    assert(frames == 0u);
    for (unsigned i = 0; i < 10u; ++i) feed((int16_t)(i + 1u), 1u);
    feed(700, 1u);
    feed(800, 1u);
    feed(900, 1u);
    assert(frames == 10u && capture.state == VOICE_CAPTURE_SPEECH);
    assert(starts[0] == 4 && starts[6] == 10);
    assert(starts[7] == 700 && starts[8] == 800 && starts[9] == 900);
    feed(0, 59u);
    assert(capture.state == VOICE_CAPTURE_SPEECH);
    feed(400, 1u); /* Soft continuing speech resets the silence timer. */
    feed(0, 59u);
    assert(capture.state == VOICE_CAPTURE_SPEECH);
    feed(0, 1u);
    assert(capture.state == VOICE_CAPTURE_FINISHED);
    assert(capture.end == VOICE_CAPTURE_END_SILENCE && frames == 130u);
    feed(800, 100u);
    assert(frames == 130u); /* Requires explicit authorization for next turn. */
}

static void exact_maximum(void)
{
    reset();
    feed(0, 100u);
    feed(INT16_MIN, 3u); /* Maximum PCM magnitude must not overflow RMS. */
    assert(frames == 10u);
    feed(1000, VOICE_CAPTURE_MAX_FRAMES - 11u);
    assert(frames == VOICE_CAPTURE_MAX_FRAMES - 1u);
    assert(capture.state == VOICE_CAPTURE_SPEECH);
    feed(1000, 1u);
    assert(frames == 1500u && capture.emitted_frames * AUDIO_FRAME == 480000u);
    assert(capture.state == VOICE_CAPTURE_FINISHED && capture.end == VOICE_CAPTURE_END_LIMIT);
    feed(1000, 10u);
    assert(frames == 1500u);
}

static void pause_and_restart(void)
{
    reset();
    feed(1200, 2u);
    voice_capture_pause(&capture);
    feed(2400, 300u); /* M5 playback can never accumulate in pre-roll. */
    assert(frames == 0u && capture.state == VOICE_CAPTURE_IDLE);
    voice_capture_listen(&capture, 0u);
    assert(capture.rms_gate == VOICE_CAPTURE_DEFAULT_RMS);
    feed(800, 3u);
    assert(frames == 3u && starts[0] == 800 && starts[2] == 800);
    voice_capture_abort(&capture, VOICE_CAPTURE_END_GAP);
    assert(capture.state == VOICE_CAPTURE_FINISHED && capture.end == VOICE_CAPTURE_END_GAP);
    feed(800, 100u);
    assert(frames == 3u);
    voice_capture_listen(&capture, 1000u);
    assert(capture.emitted_frames == 0u && capture.pre_used == 0u);
    feed(800, 100u);
    assert(frames == 3u && capture.state == VOICE_CAPTURE_LISTENING);
    voice_capture_abort(&capture, VOICE_CAPTURE_END_CANCELLED);
    assert(capture.end == VOICE_CAPTURE_END_CANCELLED);
}

static void overflow_invalidates_turn(void)
{
    reset();
    accepted_limit = 5u;
    feed(0, 10u);
    feed(800, 3u); /* Failure while flushing pre-roll is also a failed turn. */
    assert(capture.state == VOICE_CAPTURE_FINISHED && capture.end == VOICE_CAPTURE_END_OVERFLOW);
    assert(frames == 5u && capture.emitted_frames == 5u);
    feed(800, 100u);
    assert(frames == 5u);
    reset();
    feed(800, 3u);
    accepted_limit = frames;
    feed(800, 1u);
    assert(capture.end == VOICE_CAPTURE_END_OVERFLOW && capture.emitted_frames == 3u);
}

int main(void)
{
    silence_and_preroll();
    exact_maximum();
    pause_and_restart();
    overflow_invalidates_turn();
    puts("PASS: voice 30 s limit, 1.2 s silence, pre-roll, gated playback, gaps and overflow");
    return 0;
}
