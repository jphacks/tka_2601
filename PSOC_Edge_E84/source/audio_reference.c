#include "audio_reference.h"
#include "audio_reference_data.h"
#include <float.h>
#include <math.h>
#include <string.h>

#define CHECK_EVERY_FRAMES 5u
#define COOLDOWN_FRAMES 100u

const char *audio_reference_name(void) { return AUDIO_REFERENCE_NAME; }
unsigned audio_reference_frames(void) { return reference_pattern.length; }
float audio_reference_threshold(void) { return AUDIO_REFERENCE_THRESHOLD; }

void audio_reference_reset(audio_reference_matcher_t *m)
{
    memset(m, 0, sizeof(*m));
    m->last_distance = -1.0f;
}

bool audio_reference_feed(audio_reference_matcher_t *m, const audio_feature_t *feature,
                          float rms, unsigned clipped_samples, float *distance, unsigned *matched_frames)
{
    if (!isfinite(rms) || rms < 0 || clipped_samples > AUDIO_FRAME) {
        audio_reference_reset(m); return false;
    }
    m->history[m->write] = *feature;
    m->rms[m->write] = rms;
    m->clipped[m->write] = (uint16_t)clipped_samples;
    m->write = (m->write + 1u) % AUDIO_MAX_FRAMES;
    if (m->used < AUDIO_MAX_FRAMES) ++m->used;
    if (m->cooldown) { --m->cooldown; return false; }
    if (++m->stride < CHECK_EVERY_FRAMES) return false;
    m->stride = 0;
    float best = FLT_MAX;
    unsigned best_frames = 0;
    /* Permit playback-speed and frame-boundary differences without relying on
       an amplitude threshold to decide where the chime starts or ends. */
    for (unsigned percent = 80; percent <= 120; percent += 10) {
        unsigned n = (reference_pattern.length * percent + 50u) / 100u;
        if (n < 10 || n > AUDIO_MAX_FRAMES || n > m->used) continue;
        unsigned begin = (m->write + AUDIO_MAX_FRAMES - n) % AUDIO_MAX_FRAMES;
        float energy = 0, peak = 0;
        unsigned clipping = 0;
        for (unsigned i = 0; i < n; ++i) {
            unsigned pos = (begin + i) % AUDIO_MAX_FRAMES;
            energy += m->rms[pos]; peak = fmaxf(peak, m->rms[pos]);
            clipping += m->clipped[pos];
            m->trial.frame[i] = m->history[pos];
        }
        if (energy < AUDIO_REFERENCE_MIN_RMS * n || peak < AUDIO_REFERENCE_MIN_RMS * 2 ||
            clipping > n * AUDIO_FRAME / 100u) continue;
        m->trial.length = n;
        float score = audio_distance(&reference_pattern, &m->trial);
        if (score < best) { best = score; best_frames = n; }
    }
    m->last_distance = best < FLT_MAX ? best : -1.0f;
    if (best > AUDIO_REFERENCE_THRESHOLD) return false;
    *distance = best;
    *matched_frames = best_frames;
    m->cooldown = COOLDOWN_FRAMES;
    return true;
}
