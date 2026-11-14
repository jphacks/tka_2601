#include "voice_capture.h"
#include <math.h>
#include <string.h>

_Static_assert(AUDIO_RATE == 16000u && AUDIO_FRAME == 320u, "Voice framing requires 20 ms PCM16/16k");
_Static_assert(VOICE_CAPTURE_START_FRAMES <= VOICE_CAPTURE_PREROLL_FRAMES, "Start trigger must fit pre-roll");

static void clear_pending(voice_capture_t *capture)
{
    /* Erase samples when pausing: output from the speaker must not leak into
     * the next turn through pre-roll, even if the next turn begins immediately. */
    memset(capture->preroll, 0, sizeof(capture->preroll));
    capture->pre_write = capture->pre_used = capture->start_frames = 0u;
    capture->silent_frames = 0u;
}

void voice_capture_init(voice_capture_t *capture)
{
    memset(capture, 0, sizeof(*capture));
    capture->rms_gate = VOICE_CAPTURE_DEFAULT_RMS;
}

void voice_capture_listen(voice_capture_t *capture, uint32_t rms_gate)
{
    clear_pending(capture);
    capture->rms_gate = rms_gate >= 30u && rms_gate <= 32767u ?
                        rms_gate : VOICE_CAPTURE_DEFAULT_RMS;
    capture->emitted_frames = 0u;
    capture->last_rms = 0.0f;
    capture->end = VOICE_CAPTURE_END_NONE;
    capture->state = VOICE_CAPTURE_LISTENING;
}

void voice_capture_pause(voice_capture_t *capture)
{
    clear_pending(capture);
    capture->state = VOICE_CAPTURE_IDLE;
    capture->last_rms = 0.0f;
}

void voice_capture_abort(voice_capture_t *capture, voice_capture_end_t reason)
{
    if (capture->state != VOICE_CAPTURE_LISTENING && capture->state != VOICE_CAPTURE_SPEECH)
        return;
    clear_pending(capture);
    capture->end = reason;
    capture->state = VOICE_CAPTURE_FINISHED;
}

static bool emit(voice_capture_t *capture, const int16_t pcm[AUDIO_FRAME],
                 voice_capture_sink_t sink, void *context)
{
    if (!sink || !sink(context, pcm)) {
        voice_capture_abort(capture, VOICE_CAPTURE_END_OVERFLOW);
        return false;
    }
    ++capture->emitted_frames;
    if (capture->emitted_frames == VOICE_CAPTURE_MAX_FRAMES) {
        capture->state = VOICE_CAPTURE_FINISHED;
        capture->end = VOICE_CAPTURE_END_LIMIT;
        return false;
    }
    return true;
}

void voice_capture_feed(voice_capture_t *capture, const int16_t pcm[AUDIO_FRAME],
                        voice_capture_sink_t sink, void *context)
{
    if (capture->state != VOICE_CAPTURE_LISTENING && capture->state != VOICE_CAPTURE_SPEECH)
        return;
    uint64_t energy = 0u;
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) {
        int32_t sample = pcm[i];
        energy += (uint32_t)(sample * sample);
    }
    capture->last_rms = sqrtf((float)energy / (float)AUDIO_FRAME);
    if (capture->state == VOICE_CAPTURE_LISTENING) {
        memcpy(capture->preroll[capture->pre_write], pcm, sizeof(capture->preroll[0]));
        capture->pre_write = (capture->pre_write + 1u) % VOICE_CAPTURE_PREROLL_FRAMES;
        if (capture->pre_used < VOICE_CAPTURE_PREROLL_FRAMES) ++capture->pre_used;
        if (capture->last_rms >= (float)capture->rms_gate) ++capture->start_frames;
        else capture->start_frames = 0u;
        if (capture->start_frames < VOICE_CAPTURE_START_FRAMES) return;
        capture->state = VOICE_CAPTURE_SPEECH;
        uint32_t start = (capture->pre_write + VOICE_CAPTURE_PREROLL_FRAMES - capture->pre_used) %
                         VOICE_CAPTURE_PREROLL_FRAMES;
        for (uint32_t i = 0; i < capture->pre_used; ++i)
            if (!emit(capture, capture->preroll[(start + i) % VOICE_CAPTURE_PREROLL_FRAMES], sink, context))
                return;
        clear_pending(capture);
        return;
    }
    if (!emit(capture, pcm, sink, context)) return;
    /* Lower continuation gate avoids truncating soft speech after a loud onset. */
    if (capture->last_rms < (float)capture->rms_gate * 0.5f) ++capture->silent_frames;
    else capture->silent_frames = 0u;
    if (capture->silent_frames >= VOICE_CAPTURE_SILENCE_FRAMES) {
        capture->state = VOICE_CAPTURE_FINISHED;
        capture->end = VOICE_CAPTURE_END_SILENCE;
    }
}
