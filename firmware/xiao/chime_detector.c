#include "chime_detector.h"
#include <float.h>
#include <math.h>
#include <string.h>

/* Memory (ESP32-S3, all static in audio_app.c; sizes from the host build):
 *   audio_model_t     16 + 150 x 22 B (audio_frame_t)        =  3.3 KiB
 *   chime_detector_t  2 x 150 x 12 B (chime_cell_t) + 40 B   =  3.6 KiB
 *   chime_enroll_t    background 100 x 26 B, sound 200 x 22 B,
 *                     its own detector and model             = 13.7 KiB
 * Together 20.6 KiB, where the old three-template model, its enrollment copy
 * and the candidate took 25.2 KiB. The PCM for the variants is the existing
 * pending clip buffer (PSRAM); nothing is allocated.
 *
 * Work per 20 ms frame (240 MHz, single-precision FPU), estimated, not measured
 * on the board:
 *   audio_feature  512-point FFT (2304 butterflies) and 16 x 257 mel weights:
 *                  roughly 60-90 k cycles; audio_pitch adds about 1 k.
 *   DTW column     T <= 150 cells, each a 16-term integer distance and up to
 *                  four candidates with a division: roughly 150 x 150 = 23 k.
 * About 0.5 ms of the 20 ms frame. While a ring is checked, CHIME_WORK_FRAMES
 * (8) of these run per frame instead, about 4 ms, for 5 variants of at most
 * ~265 frames: the check takes at most about 3.3 s after the ring.
 */

/* history: the RMS of the two frames before, updated here. */
static float frame_features(audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME], float gate, float history[2],
                           audio_frame_t *out)
{
    float rms = audio_feature(dsp, pcm, &out->mel);
    bool rise = rms >= 2.0f * fmaxf(1.0f, fminf(history[0], history[1]));
    history[1] = history[0]; history[0] = rms;
    int16_t cent;
    float share = audio_pitch(dsp, &cent);
    if (rms < gate) { memset(out, 0, sizeof(*out)); return rms; }
    out->loud = 1;
    out->onset = rise;
    out->tonal = share >= CHIME_TONAL_SHARE;
    out->cent = (int16_t)(cent < 0 ? 0 : cent > AUDIO_CENT_MAX ? AUDIO_CENT_MAX : cent);
    return rms;
}

static float cents_apart(int16_t a, int16_t b)
{
    int32_t diff = a - b;
    if (diff < 0) diff = -diff;
    return diff >= 100 ? 1.0f : (float)diff / 100.0f;
}

static float frame_distance(const audio_frame_t *a, const audio_frame_t *b)
{
    int32_t sum = 0;
    for (unsigned k = 0; k < AUDIO_BANDS; ++k) {
        int32_t d = a->mel.band[k] - b->mel.band[k];
        sum += d * d;
    }
    float cost = (float)sum * (1.0f / (2.0f * 127.0f * 127.0f));
    if (a->tonal && b->tonal) cost += CHIME_PITCH_WEIGHT * cents_apart(a->cent, b->cent);
    else if (a->tonal != b->tonal) cost += CHIME_PITCH_WEIGHT * 0.5f;
    if (a->onset != b->onset) cost += CHIME_ONSET_WEIGHT;
    return cost;
}

/* --- Detection */
static void clear_cells(chime_detector_t *d)
{
    for (unsigned c = 0; c < 2; ++c)
        for (unsigned i = 0; i < AUDIO_TEMPLATE_FRAMES; ++i) d->column[c][i].cost = INFINITY;
    d->best = FLT_MAX;
}
void chime_detector_init(chime_detector_t *d, const audio_model_t *model)
{
    memset(d, 0, sizeof(*d));
    d->model = model;
    d->floor = fmaxf(1.0f, model->gate_rms / CHIME_ENROLL_GATE_FACTOR);
    for (unsigned i = 0; i < model->length && i < AUDIO_TEMPLATE_FRAMES; ++i) d->template_loud += model->frame[i].loud;
    clear_cells(d);
}
void chime_detector_reset(chime_detector_t *d)
{
    clear_cells(d);
    d->sounding = 0; d->quiet_run = 0;
}
float chime_detector_gate(const chime_detector_t *d) { return fmaxf(CHIME_GATE_MIN, d->floor * CHIME_GATE_FACTOR); }

static void track_floor(chime_detector_t *d, float rms, bool loud)
{
    if (loud) {
        /* A level that stays up for 5 s is the new background, not a chime. */
        if (++d->loud_run > 250u) d->floor *= 1.02f;
        return;
    }
    d->loud_run = 0;
    float r = fmaxf(rms, 1.0f);
    d->floor += (r - d->floor) * (r < d->floor ? 0.3f : 0.05f); /* falls fast, rises slowly */
}

/* Template position i (0-based) reached after n query frames: the alignment
 * may stretch at most 4/3 and compress at most 3/4, with a few frames of
 * slack until the end, where the ratio is exact. */
static bool ratio_ok(uint32_t n, unsigned m, bool end)
{
    unsigned slack = end ? 0u : 4u;
    return 3u * n <= 4u * m + 3u * slack && 4u * n + 4u * slack >= 3u * m;
}

static chime_event_t match(chime_detector_t *d, const audio_frame_t *x, float limit, chime_result_t *out)
{
    const audio_model_t *m = d->model;
    const unsigned T = m->length;
    const uint32_t t = d->frame++;
    chime_cell_t *prev = d->column[d->current], *cur = d->column[d->current ^ 1u];
    d->current ^= 1u;
    float end_score = FLT_MAX;
    for (unsigned i = 0; i < T; ++i) {
        const float dist = frame_distance(x, &m->frame[i]);
        chime_cell_t best = {.cost = INFINITY};
        float best_norm = INFINITY;
        /* Candidates: start here (i == 0), diagonal, vertical, horizontal. */
        for (unsigned c = 0; c < 4; ++c) {
            const chime_cell_t *from = NULL;
            chime_cell_t next;
            unsigned w;
            if (c == 0) {
                if (i) continue;
                next = (chime_cell_t){.cost = 0, .start = t};
                w = 2;
            } else {
                from = c == 1 ? (i ? &prev[i - 1] : NULL) : c == 2 ? (i ? &cur[i - 1] : NULL) : &prev[i];
                if (!from || !isfinite(from->cost)) continue;
                next = *from;
                if (c != 3) next.hit = 0; /* a new template frame */
                w = c == 1 ? 2u : 1u;
            }
            if (!ratio_ok(t - next.start + 1u, i + 1u, false)) continue;
            next.cost += (float)w * dist;
            next.weight = (uint16_t)(next.weight + w);
            float norm = next.cost / (float)next.weight;
            if (norm < best_norm) { best_norm = norm; best = next; }
        }
        if (isfinite(best.cost) && !best.hit && x->loud && m->frame[i].loud) { best.hit = 1; ++best.hits; }
        cur[i] = best;
    }
    const chime_cell_t *e = &cur[T - 1];
    uint32_t n = 0;
    if (isfinite(e->cost)) {
        n = t - e->start + 1u;
        if (ratio_ok(n, T, true)) end_score = e->cost / (float)e->weight;
    }
    if (out) { out->score = end_score; out->frames = n; }
    if (end_score < d->best) d->best = end_score;
    if (end_score <= limit && (float)e->hits >= CHIME_LOUD_COVER * (float)d->template_loud) {
        clear_cells(d);
        d->refractory = CHIME_REFRACTORY_FRAMES;
        d->sounding = 0;
        return CHIME_DETECTED;
    }
    return CHIME_NONE;
}

static chime_event_t step(chime_detector_t *d, const audio_frame_t *x, float rms, float limit, chime_result_t *out)
{
    track_floor(d, rms, x->loud);
    if (out) { out->score = FLT_MAX; out->frames = 0; }
    if (d->refractory) {
        if (--d->refractory == 0) clear_cells(d);
        return CHIME_NONE;
    }
    chime_event_t event = match(d, x, limit, out);
    if (event == CHIME_DETECTED) return event;
    if (x->loud) { d->sounding = 1; d->quiet_run = 0; }
    else if (d->sounding && ++d->quiet_run >= CHIME_END_FRAMES) {
        d->sounding = 0;
        if (d->best < FLT_MAX) {
            if (out) { out->score = d->best; out->frames = 0; }
            d->best = FLT_MAX;
            return CHIME_SOUND_END;
        }
    }
    return CHIME_NONE;
}

chime_event_t chime_detector_push(chime_detector_t *d, audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME],
                                  float limit, chime_result_t *out)
{
    audio_frame_t x;
    float rms = frame_features(dsp, pcm, chime_detector_gate(d), d->history, &x);
    return step(d, &x, rms, limit, out);
}
float chime_detector_last_score(const chime_detector_t *d)
{
    const chime_cell_t *e = &d->column[d->current][d->model->length - 1];
    if (!isfinite(e->cost) || !ratio_ok(d->frame - e->start, d->model->length, true)) return FLT_MAX;
    return e->cost / (float)e->weight;
}

/* --- Registration */
void chime_enroll_begin(chime_enroll_t *e)
{
    memset(e, 0, sizeof(*e));
    e->phase = CHIME_ENROLL_NOISE;
    e->seed = 0x2545f491u;
}

static chime_enroll_event_t fail(chime_enroll_t *e, chime_reason_t reason)
{
    e->phase = CHIME_ENROLL_FAILED; e->reason = reason;
    return CHIME_ENROLL_EV_FAILED;
}

static unsigned build_template(chime_enroll_t *e)
{
    unsigned len = e->length > AUDIO_TEMPLATE_FRAMES ? AUDIO_TEMPLATE_FRAMES : e->length;
    while (len && !e->sound[len - 1].loud) --len;
    audio_model_t *m = &e->model;
    memset(m, 0, sizeof(*m));
    m->version = AUDIO_MODEL_VERSION;
    m->length = len;
    m->gate_rms = e->gate;
    memcpy(m->frame, e->sound, len * sizeof(audio_frame_t));
    return len;
}

chime_enroll_event_t chime_enroll_push(chime_enroll_t *e, audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME])
{
    if (e->phase == CHIME_ENROLL_NOISE) {
        audio_frame_t f;
        float rms = frame_features(dsp, pcm, 0.0f, e->history, &f); /* gate unknown yet: keep every mel */
        e->noise[e->frames] = f; e->noise_rms[e->frames] = rms;
        e->noise_sum += rms;
        if (++e->frames < CHIME_NOISE_FRAMES) return CHIME_ENROLL_EV_NONE;
        e->floor = e->noise_sum / (float)CHIME_NOISE_FRAMES;
        e->gate = fmaxf(CHIME_GATE_MIN, e->floor * CHIME_ENROLL_GATE_FACTOR);
        if (e->gate > AUDIO_GATE_MAX) return fail(e, CHIME_REASON_NOISY);
        for (unsigned i = 0; i < CHIME_NOISE_FRAMES; ++i)
            if (e->noise_rms[i] < e->gate) memset(&e->noise[i], 0, sizeof(e->noise[i]));
        e->phase = CHIME_ENROLL_LISTEN;
        return CHIME_ENROLL_EV_NOISE_DONE;
    }
    if (e->phase != CHIME_ENROLL_LISTEN && e->phase != CHIME_ENROLL_SOUND) return CHIME_ENROLL_EV_NONE;
    audio_frame_t f;
    frame_features(dsp, pcm, e->gate, e->history, &f);
    if (e->phase == CHIME_ENROLL_LISTEN) {
        if (!f.loud) return CHIME_ENROLL_EV_NONE;
        e->phase = CHIME_ENROLL_SOUND;
        e->length = e->quiet = e->captured = 0; e->clipped = 0;
    }
    ++e->captured; /* every frame since the onset, trailing quiet included */
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        if (pcm[i] >= 32700 || pcm[i] <= -32700) ++e->clipped;
    if (e->length < CHIME_LONG_FRAMES) {
        e->sound[e->length++] = f;
    }
    e->quiet = f.loud ? 0 : e->quiet + 1;
    bool long_sound = e->length >= CHIME_LONG_FRAMES;
    if (!long_sound && e->quiet < CHIME_END_FRAMES) return CHIME_ENROLL_EV_NONE;
    if (!long_sound) e->length -= e->quiet;
    if (e->length < AUDIO_TEMPLATE_MIN_FRAMES || e->clipped * 100u > e->length * AUDIO_FRAME) {
        e->reason = e->length < AUDIO_TEMPLATE_MIN_FRAMES ? CHIME_REASON_SHORT : CHIME_REASON_CLIPPED;
        e->phase = CHIME_ENROLL_LISTEN;
        return CHIME_ENROLL_EV_RETRY;
    }
    if (build_template(e) < AUDIO_TEMPLATE_MIN_FRAMES) {
        e->reason = CHIME_REASON_SHORT; e->phase = CHIME_ENROLL_LISTEN;
        return CHIME_ENROLL_EV_RETRY;
    }
    e->phase = CHIME_ENROLL_WAIT_PCM;
    return CHIME_ENROLL_EV_NEED_PCM;
}

uint32_t chime_enroll_pcm_samples(const chime_enroll_t *e)
{
    return (CHIME_PRE_FRAMES + e->captured) * AUDIO_FRAME;
}

chime_enroll_event_t chime_enroll_set_pcm(chime_enroll_t *e, const int16_t *pcm, uint32_t samples)
{
    if (e->phase != CHIME_ENROLL_WAIT_PCM) return CHIME_ENROLL_EV_NONE;
    uint32_t after = e->captured * AUDIO_FRAME;
    if (!pcm || samples < after + AUDIO_FRAME) return fail(e, CHIME_REASON_NO_PCM);
    e->pcm = pcm; e->pcm_samples = samples; e->onset = samples - after;
    e->variant = e->position = 0;
    e->worst = 0;
    e->phase = CHIME_ENROLL_ANALYZE;
    return CHIME_ENROLL_EV_NONE;
}

static float noise_sample(uint32_t *seed)
{
    /* Sum of four uniforms: near-Gaussian, unit variance. */
    float sum = 0;
    for (unsigned i = 0; i < 4; ++i) {
        *seed ^= *seed << 13; *seed ^= *seed >> 17; *seed ^= *seed << 5;
        sum += (float)(*seed >> 8) / 16777216.0f - 0.5f;
    }
    return sum * 1.7320508f;
}

/* Variant v: 0 half-frame shift, 1 -6 dB, 2 added noise at twice the floor,
 * 3 6% slower, 4 6% faster (analysis hop changed: pitch is kept). */
static const float variant_hop[CHIME_VARIANTS] = {320.0f, 320.0f, 320.0f, 320.0f / 1.06f, 320.0f / 0.94f};

static void start_variant(chime_enroll_t *e)
{
    unsigned v = e->variant;
    chime_detector_init(&e->detector, &e->model);
    float floor = fmaxf(1.0f, e->floor);
    e->detector.floor = v == 1 ? floor * 0.5f : v == 2 ? floor * 2.236f : floor;
    e->variant_score[v] = FLT_MAX;
    e->position = 0;
}

chime_enroll_event_t chime_enroll_work(chime_enroll_t *e, audio_dsp_t *dsp, unsigned frames)
{
    if (e->phase != CHIME_ENROLL_ANALYZE) return CHIME_ENROLL_EV_NONE;
    uint32_t begin = e->onset > CHIME_PRE_FRAMES * AUDIO_FRAME ? e->onset - CHIME_PRE_FRAMES * AUDIO_FRAME : 0;
    while (frames-- && e->variant < CHIME_VARIANTS) {
        unsigned v = e->variant;
        if (e->position == 0) start_variant(e);
        uint32_t at = begin + (uint32_t)lroundf((float)e->position * variant_hop[v]) + (v == 0 ? AUDIO_FRAME / 2 : 0);
        if (at + AUDIO_FRAME > e->pcm_samples) {
            e->worst = fmaxf(e->worst, e->variant_score[v]);
            ++e->variant; e->position = 0;
            continue;
        }
        int16_t pcm[AUDIO_FRAME];
        for (unsigned i = 0; i < AUDIO_FRAME; ++i) {
            float s = e->pcm[at + i];
            if (v == 1) s *= 0.5f;
            if (v == 2) s += 2.0f * e->floor * noise_sample(&e->seed);
            pcm[i] = (int16_t)fmaxf(-32768.0f, fminf(32767.0f, s));
        }
        audio_frame_t x;
        float rms = frame_features(dsp, pcm, chime_detector_gate(&e->detector), e->detector.history, &x);
        chime_result_t r;
        step(&e->detector, &x, rms, -1.0f, &r);
        if (r.frames && r.score < e->variant_score[v]) e->variant_score[v] = r.score;
        ++e->position;
    }
    if (e->variant < CHIME_VARIANTS) return CHIME_ENROLL_EV_NONE;
    /* All variants done: threshold, then the background must not match. */
    if (!(e->worst <= CHIME_THRESHOLD_HIGH)) return fail(e, CHIME_REASON_UNSTABLE);
    float threshold = e->worst * CHIME_THRESHOLD_K + CHIME_THRESHOLD_C;
    e->model.threshold = fminf(CHIME_THRESHOLD_HIGH, fmaxf(CHIME_THRESHOLD_LOW, threshold));
    chime_detector_init(&e->detector, &e->model);
    e->noise_score = FLT_MAX;
    for (unsigned i = 0; i < CHIME_NOISE_FRAMES; ++i) {
        chime_result_t r;
        match(&e->detector, &e->noise[i], -1.0f, &r);
        if (r.frames && r.score < e->noise_score) e->noise_score = r.score;
    }
    if (e->noise_score <= e->model.threshold) return fail(e, CHIME_REASON_NOISE_MATCH);
    if (!audio_model_valid(&e->model)) return fail(e, CHIME_REASON_UNSTABLE);
    e->phase = CHIME_ENROLL_DONE;
    return CHIME_ENROLL_EV_DONE;
}

chime_enroll_event_t chime_enroll_from_pcm(chime_enroll_t *e, audio_dsp_t *dsp, const int16_t *pcm, uint32_t samples)
{
    chime_enroll_begin(e);
    for (uint32_t at = 0; at + AUDIO_FRAME <= samples; at += AUDIO_FRAME) {
        chime_enroll_event_t ev = chime_enroll_push(e, dsp, pcm + at);
        if (ev == CHIME_ENROLL_EV_FAILED) return ev;
        if (ev == CHIME_ENROLL_EV_NEED_PCM) {
            uint32_t end = at + AUDIO_FRAME, want = chime_enroll_pcm_samples(e);
            uint32_t from = end > want ? end - want : 0;
            if (chime_enroll_set_pcm(e, pcm + from, end - from) == CHIME_ENROLL_EV_FAILED) return CHIME_ENROLL_EV_FAILED;
            for (;;) {
                ev = chime_enroll_work(e, dsp, CHIME_WORK_FRAMES);
                if (ev != CHIME_ENROLL_EV_NONE) return ev;
            }
        }
    }
    return CHIME_ENROLL_EV_NONE; /* the recording ended before a whole sound */
}

const char *chime_reason_text(chime_reason_t reason)
{
    switch (reason) {
    case CHIME_REASON_NOISY: return "too_noisy";
    case CHIME_REASON_SHORT: return "too_short";
    case CHIME_REASON_CLIPPED: return "clipped";
    case CHIME_REASON_NO_PCM: return "no_recording";
    case CHIME_REASON_UNSTABLE: return "unstable";
    case CHIME_REASON_NOISE_MATCH: return "background_matches";
    default: return "none";
    }
}
