#include "chime_eval_old.h"
#include <float.h>
#include <math.h>
#include <string.h>

/* Copied from audio_core.c at d47c3c9 (renamed). */
static float feature_distance(const audio_feature_t *a, const audio_feature_t *b)
{
    float cost = 0;
    for (unsigned k = 0; k < AUDIO_BANDS; ++k) {
        float d = a->band[k] - b->band[k]; cost += d * d;
    }
    return cost / (2.0f * 127.0f * 127.0f);
}

float old_distance(const old_pattern_t *a, const old_pattern_t *b)
{
    if (a->length < 10 || b->length < 10 || a->length > OLD_MAX_FRAMES || b->length > OLD_MAX_FRAMES ||
        a->length * 4 < b->length * 3 || b->length * 4 < a->length * 3) return FLT_MAX;
    float previous[OLD_MAX_FRAMES + 1], current[OLD_MAX_FRAMES + 1];
    for (unsigned j = 0; j <= b->length; ++j) previous[j] = FLT_MAX;
    previous[0] = 0;
    for (unsigned i = 1; i <= a->length; ++i) {
        for (unsigned j = 0; j <= b->length; ++j) current[j] = FLT_MAX;
        for (unsigned j = 1; j <= b->length; ++j) {
            if (fabsf((float)i / a->length - (float)j / b->length) > 0.15f) continue;
            float d = feature_distance(&a->frame[i - 1], &b->frame[j - 1]);
            current[j] = fminf(previous[j - 1] + 2 * d,
                              fminf(previous[j] + d, current[j - 1] + d));
        }
        memcpy(previous, current, sizeof(previous));
    }
    return previous[b->length] / (a->length + b->length);
}

static bool model_valid(const old_model_t *m)
{
    if (m->count != OLD_TEMPLATES || !isfinite(m->gate_rms) || m->gate_rms < 30 || m->gate_rms > 16000 ||
        !isfinite(m->threshold) || m->threshold < 0.02f || m->threshold > 0.25f) return false;
    for (unsigned i = 0; i < OLD_TEMPLATES; ++i)
        if (m->pattern[i].length < 10 || m->pattern[i].length > OLD_MAX_FRAMES) return false;
    return true;
}

static float match(const old_model_t *m, const old_pattern_t *candidate)
{
    if (!model_valid(m)) return FLT_MAX;
    float best = FLT_MAX;
    for (unsigned i = 0; i < OLD_TEMPLATES; ++i) best = fminf(best, old_distance(&m->pattern[i], candidate));
    return best;
}

static bool calibrate(old_model_t *m)
{
    if (m->count != OLD_TEMPLATES) return false;
    float worst = 0;
    for (unsigned i = 0; i < OLD_TEMPLATES; ++i)
        for (unsigned j = i + 1; j < OLD_TEMPLATES; ++j)
            worst = fmaxf(worst, old_distance(&m->pattern[i], &m->pattern[j]));
    if (worst > 0.15f) return false;
    m->threshold = fminf(0.25f, fmaxf(0.08f, worst * 1.8f + 0.03f));
    return model_valid(m);
}

void old_begin_enroll(old_detector_t *d)
{
    memset(&d->enrolling, 0, sizeof(d->enrolling));
    d->mode = OLD_NOISE; d->noise_frames = 0; d->noise_sum = 0; d->candidate.length = 0;
}

/* The NORMAL/NOISE/ENROLL/VERIFY part of audio_app_frame() at d47c3c9, with
 * the margin at 100%. */
bool old_push(old_detector_t *d, audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME])
{
    audio_feature_t feature;
    float rms = audio_feature(dsp, pcm, &feature);
    if (d->mode == OLD_NOISE) {
        d->noise_sum += rms;
        if (++d->noise_frames == 250) {
            d->enrolling.gate_rms = fmaxf(80.0f, d->noise_sum / d->noise_frames * 4.0f);
            if (d->enrolling.gate_rms > 16000) { d->mode = OLD_NORMAL; return false; }
            d->mode = OLD_ENROLL; d->quiet = 0; d->reject_until_quiet = 0;
        }
        return false;
    }
    float gate = d->mode == OLD_NORMAL ? d->model.gate_rms : d->enrolling.gate_rms;
    if (d->mode == OLD_NORMAL && !d->valid) return false;
    bool loud = rms >= gate;
    if (d->reject_until_quiet) {
        if (loud) d->reject_until_quiet = 50;
        else --d->reject_until_quiet;
        return false;
    }
    old_pattern_t *c = &d->candidate;
    if (!c->length && !loud) return false;
    if (!c->length) { d->quiet = 0; d->clipped = 0; }
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        if (pcm[i] >= 32700 || pcm[i] <= -32700) ++d->clipped;
    if (!loud) memset(&feature, 0, sizeof(feature));
    if (c->length == OLD_MAX_FRAMES + OLD_END_FRAMES || (loud && c->length >= OLD_MAX_FRAMES)) {
        c->length = 0; d->reject_until_quiet = 50; return false;
    }
    c->frame[c->length++] = feature;
    d->quiet = loud ? 0 : d->quiet + 1;
    if (d->quiet < OLD_END_FRAMES) return false;
    c->length -= d->quiet;
    if (c->length < 10 || d->clipped > c->length * AUDIO_FRAME / 100) { c->length = 0; return false; }
    bool detected = false;
    if (d->mode == OLD_ENROLL) {
        d->enrolling.pattern[d->enrolling.count++] = *c;
        if (d->enrolling.count == OLD_TEMPLATES) d->mode = calibrate(&d->enrolling) ? OLD_VERIFY : OLD_NORMAL;
    } else if (d->mode == OLD_VERIFY) {
        if (match(&d->enrolling, c) <= d->enrolling.threshold) {
            d->model = d->enrolling; d->valid = true; d->mode = OLD_NORMAL;
        }
    } else {
        d->last_score = match(&d->model, c);
        if (d->last_score <= d->model.threshold) { detected = true; d->reject_until_quiet = 50; }
    }
    c->length = 0;
    return detected;
}
