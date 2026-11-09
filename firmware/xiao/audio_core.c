#include "audio_core.h"
#include <math.h>
#include <string.h>

#define PI_F 3.14159265358979323846f

void audio_dsp_init(audio_dsp_t *dsp)
{
    memset(dsp, 0, sizeof(*dsp));
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        dsp->window[i] = 0.5f - 0.5f * cosf(2.0f * PI_F * i / (AUDIO_FRAME - 1));
    float edges[AUDIO_BANDS + 2];
    const float low = 2595.0f * log10f(1.0f + 200.0f / 700.0f);
    const float high = 2595.0f * log10f(1.0f + 6000.0f / 700.0f);
    for (unsigned i = 0; i < AUDIO_BANDS + 2; ++i)
        edges[i] = 700.0f * (powf(10.0f, (low + (high - low) * i / (AUDIO_BANDS + 1)) / 2595.0f) - 1.0f);
    for (unsigned b = 0; b < AUDIO_BANDS; ++b)
        for (unsigned k = 0; k <= 256; ++k) {
            float hz = (float)k * AUDIO_RATE / 512.0f;
            float w = hz < edges[b + 1] ? (hz - edges[b]) / (edges[b + 1] - edges[b])
                                        : (edges[b + 2] - hz) / (edges[b + 2] - edges[b + 1]);
            dsp->weight[b][k] = fmaxf(0.0f, w);
        }
}

float audio_feature(audio_dsp_t *dsp, const int16_t pcm[AUDIO_FRAME], audio_feature_t *out)
{
    float mean = 0, energy = 0;
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) mean += pcm[i];
    mean /= AUDIO_FRAME;
    for (unsigned i = 0; i < 512; ++i) {
        float v = i < AUDIO_FRAME ? (float)pcm[i] - mean : 0;
        energy += v * v;
        dsp->real[i] = i < AUDIO_FRAME ? v * dsp->window[i] : 0;
        dsp->imag[i] = 0;
    }
    for (unsigned i = 1, j = 0; i < 512; ++i) {
        unsigned bit = 256;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float t = dsp->real[i]; dsp->real[i] = dsp->real[j]; dsp->real[j] = t;
        }
    }
    for (unsigned n = 2; n <= 512; n <<= 1) {
        float wr = cosf(-2 * PI_F / n), wi = sinf(-2 * PI_F / n);
        for (unsigned start = 0; start < 512; start += n) {
            float r = 1, im = 0;
            for (unsigned j = 0; j < n / 2; ++j) {
                unsigned a = start + j, b = a + n / 2;
                float tr = r * dsp->real[b] - im * dsp->imag[b];
                float ti = r * dsp->imag[b] + im * dsp->real[b];
                dsp->real[b] = dsp->real[a] - tr; dsp->imag[b] = dsp->imag[a] - ti;
                dsp->real[a] += tr; dsp->imag[a] += ti;
                float next = r * wr - im * wi;
                im = r * wi + im * wr; r = next;
            }
        }
    }
    float bands[AUDIO_BANDS], average = 0, norm = 0;
    for (unsigned k = 0; k <= 256; ++k)
        dsp->real[k] = dsp->real[k] * dsp->real[k] + dsp->imag[k] * dsp->imag[k];
    float total = 0;
    for (unsigned b = 0; b < AUDIO_BANDS; ++b) {
        float sum = 0;
        for (unsigned k = 0; k <= 256; ++k) sum += dsp->weight[b][k] * dsp->real[k];
        bands[b] = sum; total += sum;
    }
    /* Relative spectral floor preserves gain invariance, including FFT leakage. */
    for (unsigned b = 0; b < AUDIO_BANDS; ++b) {
        bands[b] = logf(fmaxf(bands[b], total * 0.0001f) + 1.0f);
        average += bands[b];
    }
    average /= AUDIO_BANDS;
    for (unsigned b = 0; b < AUDIO_BANDS; ++b) { bands[b] -= average; norm += bands[b] * bands[b]; }
    norm = sqrtf(norm);
    for (unsigned b = 0; b < AUDIO_BANDS; ++b)
        out->band[b] = norm > 0.001f ? (int8_t)lroundf(127.0f * bands[b] / norm) : 0;
    return sqrtf(energy / AUDIO_FRAME);
}

static int16_t peak_cents(const float *p, unsigned k)
{
    float a = logf(p[k - 1] + 1e-6f), b = logf(p[k] + 1e-6f), c = logf(p[k + 1] + 1e-6f);
    float den = a - 2.0f * b + c, delta = den < 0 ? 0.5f * (a - c) / den : 0;
    delta = fmaxf(-0.5f, fminf(0.5f, delta));
    float hz = ((float)k + delta) * AUDIO_RATE / 512.0f;
    return (int16_t)lroundf(1200.0f * log2f(hz / 55.0f));
}

float audio_pitch(const audio_dsp_t *dsp, int16_t *cent)
{
    /* audio_feature() leaves the power spectrum of the frame in real[0..256]. */
    const float *p = dsp->real;
    unsigned best = 10; /* 312.5 Hz */
    for (unsigned k = 11; k <= 128; ++k) /* .. 4000 Hz */
        if (p[k] > p[best]) best = k;
    float total = 0;
    for (unsigned k = 7; k <= 192; ++k) total += p[k]; /* 219-6000 Hz */
    *cent = 0;
    if (!(total > 0) || !(p[best] > 0)) return 0;
    *cent = peak_cents(p, best);
    return fminf(1.0f, (p[best - 1] + p[best] + p[best + 1]) / total);
}

bool audio_model_valid(const audio_model_t *m)
{
    if (m->version != AUDIO_MODEL_VERSION || m->length < AUDIO_TEMPLATE_MIN_FRAMES ||
        m->length > AUDIO_TEMPLATE_FRAMES ||
        !isfinite(m->gate_rms) || m->gate_rms < 30 || m->gate_rms > AUDIO_GATE_MAX ||
        !isfinite(m->threshold) || m->threshold < AUDIO_THRESHOLD_MIN || m->threshold > AUDIO_THRESHOLD_MAX) return false;
    unsigned loud = 0;
    for (unsigned i = 0; i < m->length; ++i) {
        const audio_frame_t *f = &m->frame[i];
        if (f->loud > 1 || f->tonal > 1 || f->onset > f->loud || f->cent < 0 || f->cent > AUDIO_CENT_MAX) return false;
        loud += f->loud;
    }
    /* A registered sound starts and ends loud, and is mostly sound. */
    return m->frame[0].loud && m->frame[m->length - 1].loud && loud * 2 >= m->length;
}

uint32_t audio_crc32(const void *data, size_t length)
{
    const uint8_t *p = data; uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < length; ++i) {
        crc ^= p[i];
        for (unsigned j = 0; j < 8; ++j) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}
static void le32(uint8_t *p, uint32_t n) { for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(n >> (8 * i)); }
void audio_wav_header(uint8_t h[44], uint32_t samples)
{
    memset(h, 0, 44); memcpy(h, "RIFF", 4); le32(h + 4, samples * 2 + 36);
    memcpy(h + 8, "WAVEfmt ", 8); le32(h + 16, 16); h[20] = 1; h[22] = 1;
    le32(h + 24, AUDIO_RATE); le32(h + 28, AUDIO_RATE * 2); h[32] = 2; h[34] = 16;
    memcpy(h + 36, "data", 4); le32(h + 40, samples * 2);
}
void audio_ring_push(audio_ring_t *r, const int16_t *pcm, uint32_t n)
{
    for (uint32_t i = 0; i < n; ++i) {
        r->pcm[r->write] = pcm[i]; r->write = (r->write + 1) % AUDIO_CLIP_SAMPLES;
        if (r->used < AUDIO_CLIP_SAMPLES) ++r->used;
    }
}
uint32_t audio_ring_copy(const audio_ring_t *r, int16_t *out, uint32_t n)
{
    if (n > r->used) n = r->used;
    uint32_t pos = (r->write + AUDIO_CLIP_SAMPLES - n) % AUDIO_CLIP_SAMPLES;
    for (uint32_t i = 0; i < n; ++i) out[i] = r->pcm[(pos + i) % AUDIO_CLIP_SAMPLES];
    return n;
}
