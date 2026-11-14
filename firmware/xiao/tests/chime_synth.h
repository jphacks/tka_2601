#pragma once
/* Seeded synthetic chimes, transmission paths, noises and other sounds, for
 * tests/chime_eval.c and tests/test_chime.c. Host only. Every generator is
 * deterministic for a given seed. None of this is a recording of a real
 * intercom: results on it are not field performance. */
#include "audio_core.h"
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define SYN_PI 3.14159265358979f
#define SYN_LEVEL 3000.0f /* active RMS of a chime at 0 dB */
#define SYN_ROOM 20.0f    /* RMS of the quiet-room pink noise under everything */

typedef struct { uint64_t s; } syn_rng_t;
static inline uint32_t syn_u32(syn_rng_t *r)
{
    uint64_t z = (r->s += 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return (uint32_t)((z ^ (z >> 31)) >> 32);
}
static inline float syn_uniform(syn_rng_t *r, float lo, float hi)
{
    return lo + (hi - lo) * (float)(syn_u32(r) >> 8) / 16777216.0f;
}
static inline float syn_gauss(syn_rng_t *r)
{
    float s = 0;
    for (int i = 0; i < 6; ++i) s += syn_uniform(r, -0.5f, 0.5f);
    return s * 1.4142136f;
}

typedef struct {
    unsigned notes, partials;
    float hz[6], onset[6], tau[6];
    float ratio[4], level[4];
    float duration;
} syn_chime_t;

static inline float syn_note(int semitone) { return 440.0f * powf(2.0f, (float)semitone / 12.0f); }

/* A 2- or 3-note chime: 415-1175 Hz on the A440 grid, harmonic or bar-like
 * partials, exponential decay, notes ringing on under the next one. */
static inline void syn_chime(syn_chime_t *c, syn_rng_t *r)
{
    memset(c, 0, sizeof(*c));
    c->notes = 2u + syn_u32(r) % 2u;
    int used[6];
    for (unsigned i = 0; i < c->notes; ++i) {
        int n;
        for (;;) {
            n = -1 + (int)(syn_u32(r) % 19u);
            bool ok = true;
            for (unsigned j = 0; j < i; ++j) if (abs(n - used[j]) < 2) ok = false;
            if (ok) break;
        }
        used[i] = n;
        c->hz[i] = syn_note(n);
    }
    float gap = syn_uniform(r, 0.3f, 0.6f), tau = syn_uniform(r, 0.3f, 0.8f);
    for (unsigned i = 0; i < c->notes; ++i) {
        c->onset[i] = 0.01f + gap * (float)i;
        c->tau[i] = tau * syn_uniform(r, 0.85f, 1.15f);
    }
    c->partials = 3;
    c->ratio[0] = 1; c->level[0] = 1;
    if (syn_u32(r) % 2u) { c->ratio[1] = 2; c->ratio[2] = 3; }
    else { c->ratio[1] = 2.76f; c->ratio[2] = 5.40f; }
    c->level[1] = syn_uniform(r, 0.1f, 0.45f);
    c->level[2] = syn_uniform(r, 0.03f, 0.2f);
    c->duration = c->onset[c->notes - 1] + fminf(1.5f, 3.0f * tau);
}
/* Same notes in another order (reversed; rotated if reversing changes nothing). */
static inline void syn_swap(syn_chime_t *c)
{
    float hz[6];
    for (unsigned i = 0; i < c->notes; ++i) hz[i] = c->hz[c->notes - 1 - i];
    if (c->notes == 3 && hz[1] == c->hz[1] && hz[0] == c->hz[0])
        for (unsigned i = 0; i < 3; ++i) hz[i] = c->hz[(i + 1) % 3];
    memcpy(c->hz, hz, sizeof(hz));
}
/* True when `inside` plays the notes of `tune` in a row (within 1.5
 * semitones): such a chime contains the registered one, so it is not a
 * negative. */
static inline bool syn_contains_tune(const syn_chime_t *inside, const syn_chime_t *tune)
{
    for (unsigned at = 0; at + tune->notes <= inside->notes; ++at) {
        bool same = true;
        for (unsigned i = 0; i < tune->notes; ++i)
            if (fabsf(12.0f * log2f(inside->hz[at + i] / tune->hz[i])) >= 1.5f) same = false;
        if (same) return true;
    }
    return false;
}
static inline void syn_render(const syn_chime_t *c, float *out, size_t samples, float start)
{
    for (unsigned n = 0; n < c->notes; ++n) {
        float t0 = start + c->onset[n];
        size_t first = (size_t)(t0 * AUDIO_RATE);
        size_t last = (size_t)((start + c->duration) * AUDIO_RATE);
        for (size_t i = first; i < last && i < samples; ++i) {
            float t = (float)(i - first) / AUDIO_RATE;
            float attack = fminf(1.0f, t / 0.004f);
            float fade = fminf(1.0f, (float)(last - i) / (0.05f * AUDIO_RATE));
            float v = 0;
            for (unsigned p = 0; p < c->partials; ++p) {
                float tau = c->tau[n] / sqrtf(c->ratio[p]);
                v += c->level[p] * expf(-t / tau) * sinf(2.0f * SYN_PI * c->hz[n] * c->ratio[p] * t);
            }
            out[i] += attack * fade * v;
        }
    }
}

/* Mean power of the 20 ms frames within 20 dB of the loudest frame. */
static inline float syn_active_rms(const float *x, size_t samples)
{
    size_t frames = samples / AUDIO_FRAME;
    float peak = 0;
    for (size_t f = 0; f < frames; ++f) {
        float e = 0;
        for (unsigned i = 0; i < AUDIO_FRAME; ++i) e += x[f * AUDIO_FRAME + i] * x[f * AUDIO_FRAME + i];
        peak = fmaxf(peak, e);
    }
    double sum = 0; size_t count = 0;
    for (size_t f = 0; f < frames; ++f) {
        float e = 0;
        for (unsigned i = 0; i < AUDIO_FRAME; ++i) e += x[f * AUDIO_FRAME + i] * x[f * AUDIO_FRAME + i];
        if (e >= peak / 100.0f) { sum += e; ++count; }
    }
    return count ? sqrtf((float)(sum / (double)(count * AUDIO_FRAME))) : 0;
}
static inline void syn_scale(float *x, size_t samples, float rms)
{
    float now = syn_active_rms(x, samples);
    if (now > 0) for (size_t i = 0; i < samples; ++i) x[i] *= rms / now;
}

/* --- Transmission */
static inline void syn_tilt_up(float *x, size_t n)
{
    float prev = 0;
    for (size_t i = 0; i < n; ++i) { float v = x[i]; x[i] = v - 0.7f * prev; prev = v; }
}
static inline void syn_tilt_down(float *x, size_t n)
{
    float y = 0;
    for (size_t i = 0; i < n; ++i) { y = 0.6f * y + 0.4f * x[i]; x[i] = y; }
}
/* Sparse exponential reverb tail, RT60 0.5 s, half the direct energy. */
static inline void syn_reverb(float *x, size_t n, syn_rng_t *r)
{
    enum { TAPS = 400 };
    size_t delay[TAPS]; float gain[TAPS]; float energy = 0;
    for (unsigned k = 0; k < TAPS; ++k) {
        float t = syn_uniform(r, 0.003f, 0.4f);
        delay[k] = (size_t)(t * AUDIO_RATE);
        gain[k] = (syn_u32(r) & 1u ? 1.0f : -1.0f) * expf(-6.9f * t / 0.5f);
        energy += gain[k] * gain[k];
    }
    for (unsigned k = 0; k < TAPS; ++k) gain[k] *= sqrtf(0.5f / energy);
    float *dry = malloc(n * sizeof(float));
    memcpy(dry, x, n * sizeof(float));
    for (unsigned k = 0; k < TAPS; ++k)
        for (size_t i = delay[k]; i < n; ++i) x[i] += gain[k] * dry[i - delay[k]];
    free(dry);
}

/* --- Noises, added at a given RMS. */
static inline void syn_add_pink(float *x, size_t n, float rms, syn_rng_t *r)
{
    float *v = malloc(n * sizeof(float));
    float b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    double e = 0;
    for (size_t i = 0; i < n; ++i) {
        float w = syn_gauss(r);
        b0 = 0.99886f * b0 + w * 0.0555179f; b1 = 0.99332f * b1 + w * 0.0750759f;
        b2 = 0.96900f * b2 + w * 0.1538520f; b3 = 0.86650f * b3 + w * 0.3104856f;
        b4 = 0.55000f * b4 + w * 0.5329522f; b5 = -0.7616f * b5 - w * 0.0168980f;
        v[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362f; b6 = w * 0.115926f;
        e += (double)v[i] * v[i];
    }
    float g = rms / sqrtf((float)(e / (double)n));
    for (size_t i = 0; i < n; ++i) x[i] += g * v[i];
    free(v);
}
static inline void syn_add_white(float *x, size_t n, float rms, syn_rng_t *r)
{
    for (size_t i = 0; i < n; ++i) x[i] += rms * syn_gauss(r);
}

/* A voiced syllable: glottal pulses through three formant resonators. */
static inline void syn_vowel(float *x, size_t n, size_t at, float seconds, syn_rng_t *r)
{
    static const float formant[5][3] = {
        {800, 1200, 2500}, {300, 2300, 3000}, {350, 1300, 2400}, {500, 1900, 2500}, {500, 900, 2400}};
    const float *f = formant[syn_u32(r) % 5u];
    float f0 = syn_uniform(r, 100.0f, 250.0f), glide = syn_uniform(r, -0.3f, 0.3f);
    float y[3][2] = {{0}}, phase = 0;
    size_t len = (size_t)(seconds * AUDIO_RATE);
    for (size_t i = 0; i < len && at + i < n; ++i) {
        float t = (float)i / (float)len;
        float hz = f0 * (1.0f + glide * t) * (1.0f + 0.02f * sinf(2 * SYN_PI * 5.0f * (float)i / AUDIO_RATE));
        phase += hz / AUDIO_RATE;
        float source = 0;
        if (phase >= 1.0f) { phase -= 1.0f; source = 1.0f; }
        source += 0.02f * syn_gauss(r);
        float v = 0;
        for (unsigned k = 0; k < 3; ++k) {
            float bw = 80.0f + 40.0f * (float)k, rr = expf(-SYN_PI * bw / AUDIO_RATE);
            float a1 = 2 * rr * cosf(2 * SYN_PI * f[k] / AUDIO_RATE), a2 = -rr * rr;
            float out = source + a1 * y[k][0] + a2 * y[k][1];
            y[k][1] = y[k][0]; y[k][0] = out;
            v += out / (float)(k + 1);
        }
        float env = sinf(SYN_PI * t);
        x[at + i] += env * v;
    }
}
static inline void syn_speech(float *x, size_t n, size_t at, float seconds, syn_rng_t *r)
{
    float t = 0;
    while (t < seconds) {
        float len = syn_uniform(r, 0.12f, 0.3f);
        syn_vowel(x, n, at + (size_t)(t * AUDIO_RATE), len, r);
        t += len + syn_uniform(r, 0.03f, 0.15f);
    }
}
/* Speech-like noise: three talkers at once, at a given RMS over the span. */
static inline void syn_add_babble(float *x, size_t n, float rms, syn_rng_t *r)
{
    float *v = calloc(n, sizeof(float));
    for (int k = 0; k < 3; ++k) syn_speech(v, n, 0, (float)n / AUDIO_RATE, r);
    double e = 0;
    for (size_t i = 0; i < n; ++i) e += (double)v[i] * v[i];
    float g = rms / sqrtf((float)(e / (double)n) + 1e-12f);
    for (size_t i = 0; i < n; ++i) x[i] += g * v[i];
    free(v);
}
/* Music: a random major-scale melody with harmonic, decaying notes. */
static inline void syn_music(float *x, size_t n, size_t at, float seconds, syn_rng_t *r)
{
    static const int major[7] = {0, 2, 4, 5, 7, 9, 11};
    int key = (int)(syn_u32(r) % 12u) - 12;
    float t = 0;
    while (t < seconds) {
        int degree = (int)(syn_u32(r) % 14u);
        float hz = syn_note(key + 12 * (degree / 7) + major[degree % 7]);
        while (hz < 300.0f) hz *= 2.0f;
        while (hz > 1500.0f) hz *= 0.5f;
        float len = syn_uniform(r, 0.12f, 0.5f);
        size_t first = at + (size_t)(t * AUDIO_RATE), count = (size_t)(len * AUDIO_RATE * 1.3f);
        for (size_t i = 0; i < count && first + i < n; ++i) {
            float s = (float)i / AUDIO_RATE, v = 0;
            for (int k = 1; k <= 6; ++k) v += sinf(2 * SYN_PI * hz * (float)k * s) / (float)k;
            x[first + i] += fminf(1.0f, s / 0.01f) * expf(-s / 0.3f) * fminf(1.0f, (float)(count - i) / 160.0f) * v;
        }
        t += len;
    }
}
/* Knocks: short resonant noise bursts. */
static inline void syn_knock(float *x, size_t n, size_t at, syn_rng_t *r)
{
    unsigned count = 3u + syn_u32(r) % 3u;
    float t = 0;
    for (unsigned k = 0; k < count; ++k) {
        float f = syn_uniform(r, 150.0f, 400.0f), rr = expf(-SYN_PI * 60.0f / AUDIO_RATE);
        float a1 = 2 * rr * cosf(2 * SYN_PI * f / AUDIO_RATE), a2 = -rr * rr, y1 = 0, y2 = 0;
        size_t first = at + (size_t)(t * AUDIO_RATE);
        for (size_t i = 0; i < 1200 && first + i < n; ++i) {
            float env = expf(-(float)i / 160.0f), w = syn_gauss(r) * env;
            float y = w + a1 * y1 + a2 * y2; y2 = y1; y1 = y;
            x[first + i] += 0.3f * y + w;
        }
        t += syn_uniform(r, 0.15f, 0.3f);
    }
}

static inline void syn_to_pcm(const float *x, int16_t *pcm, size_t n)
{
    for (size_t i = 0; i < n; ++i) pcm[i] = (int16_t)fmaxf(-32768.0f, fminf(32767.0f, lroundf(x[i])));
}
