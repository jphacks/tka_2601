#include "audio_core.h"
#include "audio_store.h"
#include <assert.h>
#include <float.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static audio_dsp_t dsp;
static audio_model_t model, restored;
static audio_pattern_t other;
static audio_ring_t ring;
static uint8_t flash_memory[AUDIO_STORE_BYTES];
static long fail_after = -1;
static bool read_flash(uint32_t off, void *out, size_t n)
{
    if (off > sizeof(flash_memory) || n > sizeof(flash_memory) - off) return false;
    memcpy(out, flash_memory + off, n); return true;
}
static bool write_flash(uint32_t off, const void *data, size_t n)
{
    if (off > sizeof(flash_memory) || n > sizeof(flash_memory) - off) return false;
    const uint8_t *p = data;
    for (size_t i = 0; i < n; ++i) {
        if (fail_after == 0) return false;
        if (fail_after > 0) --fail_after;
        assert((flash_memory[off + i] & p[i]) == p[i]);
        flash_memory[off + i] &= p[i];
    }
    return true;
}
static bool erase_flash(uint32_t off, size_t n)
{
    assert(off % AUDIO_SLOT_SIZE == 0 && n % AUDIO_SLOT_SIZE == 0);
    memset(flash_memory + off, 255, n); return true;
}
static void pattern(audio_pattern_t *p, unsigned count, float gain, bool reverse, bool noise)
{
    memset(p, 0, sizeof(*p)); p->length = count;
    uint32_t seed = 12345;
    int16_t pcm[AUDIO_FRAME];
    for (unsigned f = 0; f < count; ++f) {
        bool second = f >= count / 2;
        float hz = (second != reverse) ? 880.0f : 1320.0f;
        for (unsigned i = 0; i < AUDIO_FRAME; ++i) {
            seed = seed * 1664525u + 1013904223u;
            float random = (float)((int32_t)(seed >> 16) - 32768) / 32768.0f;
            float v = noise ? random : sinf(6.2831853f * hz * (f * AUDIO_FRAME + i) / AUDIO_RATE) + 0.005f * random;
            pcm[i] = (int16_t)(gain * v);
        }
        audio_feature(&dsp, pcm, &p->frame[f]);
    }
}
static void test_matching(void)
{
    audio_dsp_init(&dsp);
    model.version = AUDIO_MODEL_VERSION; model.count = 3; model.gate_rms = 100;
    pattern(&model.pattern[0], 50, 8000, false, false);
    pattern(&model.pattern[1], 52, 4000, false, false);
    pattern(&model.pattern[2], 48, 12000, false, false);
    assert(audio_calibrate(&model));
    pattern(&other, 54, 2000, false, false);
    printf("matching distance %.5f, threshold %.5f\n", (double)audio_match(&model, &other), (double)model.threshold);
    assert(audio_match(&model, &other) < model.threshold);
    pattern(&other, 50, 8000, true, false);
    assert(audio_match(&model, &other) > model.threshold);
    pattern(&other, 50, 8000, false, true);
    assert(audio_match(&model, &other) > model.threshold);
    other.length = 0; assert(audio_match(&model, &other) == FLT_MAX);
    other.length = AUDIO_MAX_FRAMES + 1; assert(audio_match(&model, &other) == FLT_MAX);
    restored = model; restored.gate_rms = NAN; assert(!audio_model_valid(&restored));
    restored = model; restored.pattern[0].length = 1; assert(!audio_model_valid(&restored));
    restored = model; pattern(&restored.pattern[2], 50, 8000, true, false); assert(!audio_calibrate(&restored));
}
static void test_ring_wav(void)
{
    int16_t samples[100], output[100];
    for (unsigned step = 0; step < AUDIO_CLIP_SAMPLES / 100 + 2; ++step) {
        for (unsigned i = 0; i < 100; ++i) samples[i] = (int16_t)(step * 100 + i);
        audio_ring_push(&ring, samples, 100);
    }
    assert(audio_ring_copy(&ring, output, 100) == 100);
    assert(memcmp(samples, output, sizeof(samples)) == 0);
    uint8_t wav[44]; audio_wav_header(wav, 16000);
    assert(!memcmp(wav, "RIFF", 4) && !memcmp(wav + 8, "WAVEfmt ", 8));
    assert(wav[40] == 0x00 && wav[41] == 0x7d && wav[34] == 16 && wav[22] == 1);
    assert(audio_crc32("123456789", 9) == 0xcbf43926u);
}
static void test_storage(void)
{
    memset(flash_memory, 255, sizeof(flash_memory));
    audio_flash_t ops = {read_flash, write_flash, erase_flash};
    audio_store_t store;
    assert(!audio_store_open(&store, ops));
    assert(!audio_store_save_model(&store, &model));
    assert(audio_store_format(&store));
    assert(audio_store_save_model(&store, &model));
    assert(audio_store_open(&store, ops));
    assert(audio_store_load_model(&store, &restored));
    assert(memcmp(&model, &restored, sizeof(model)) == 0);
    /* Cut power halfway through both payload and commit-header writes. */
    const long cuts[] = {0, 120, (long)sizeof(model) + 20};
    for (unsigned i = 0; i < sizeof(cuts) / sizeof(cuts[0]); ++i) {
        fail_after = cuts[i]; assert(!audio_store_save_model(&store, &model)); fail_after = -1;
        assert(audio_store_open(&store, ops));
        assert(audio_store_load_model(&store, &restored));
        assert(memcmp(&model, &restored, sizeof(model)) == 0);
    }
    int16_t pcm[320] = {1, 2, -3}; uint32_t id[4] = {1, 2, 3, 4};
    fail_after = 20; assert(!audio_store_enqueue(&store, pcm, 320, id, 0.01f)); fail_after = -1;
    assert(audio_store_open(&store, ops)); assert(audio_store_pending(&store) == -1);
    for (unsigned i = 3; i < AUDIO_SLOT_COUNT; ++i) { id[0] = i; assert(audio_store_enqueue(&store, pcm, 320, id, 0.01f)); }
    assert(!audio_store_enqueue(&store, pcm, 320, id, 0.01f)); /* full: no overwrite */
    assert(audio_store_open(&store, ops));
    int pending = audio_store_pending(&store); assert(pending == 3);
    int16_t received[320];
    assert(audio_store_read_audio(&store, 3, 0, received, sizeof(received)));
    assert(!memcmp(received, pcm, sizeof(pcm)));
    assert(!audio_store_read_audio(&store, 3, 640, received, 2));
    assert(audio_store_verify(&store, 3));
    assert(audio_store_ack(&store, 3));
    assert(audio_store_open(&store, ops)); assert(audio_store_pending(&store) == 4);
    assert(audio_store_enqueue(&store, pcm, 320, id, 0.01f));
    flash_memory[3 * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET] ^= 1;
    assert(!audio_store_verify(&store, 3)); /* corruption cannot be uploaded */
}
int main(void)
{
    test_matching(); test_ring_wav(); test_storage();
    puts("PASS: matching, noise rejection, ring/WAV, reboot recovery, power cuts, queue bounds, CRC");
    return 0;
}
