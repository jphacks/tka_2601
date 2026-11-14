#include "audio_core.h"
#include "audio_store.h"
#include <assert.h>
#include <stddef.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static audio_model_t model, restored;
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
/* A small valid v2 model: 40 loud frames, two notes. */
static void make_model(audio_model_t *m)
{
    memset(m, 0, sizeof(*m));
    m->version = AUDIO_MODEL_VERSION; m->length = 40; m->gate_rms = 100; m->threshold = 0.2f;
    for (unsigned f = 0; f < m->length; ++f) {
        audio_frame_t *x = &m->frame[f];
        x->loud = 1; x->tonal = 1; x->onset = f == 0 || f == 20;
        x->cent = f < 20 ? 4500 : 4200;
        for (unsigned b = 0; b < AUDIO_BANDS; ++b) x->mel.band[b] = (int8_t)((b == (f < 20 ? 9u : 7u)) ? 100 : -7);
    }
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
    make_model(&model);
    assert(audio_model_valid(&model));
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
    /* A model that fails its own checks is neither saved nor loaded. */
    restored = model; restored.threshold = NAN;
    assert(!audio_store_save_model(&store, &restored));
    /* A v1 record (three mel templates, 10 812 bytes) from older firmware is
     * not loaded: the store reports no model and registration starts over. */
    {
        uint8_t v1[16 + 3 * (4 + 225 * 16)];
        memset(v1, 0, sizeof(v1)); v1[0] = 1; v1[4] = 3;
        audio_record_t h = {.magic = 0x41554431u, .version = 1, .type = 2, .generation = 99, .length = sizeof(v1)};
        h.crc = audio_crc32(v1, sizeof(v1)); h.acknowledged = UINT32_MAX;
        h.header_crc = audio_crc32(&h, offsetof(audio_record_t, header_crc));
        uint8_t saved[AUDIO_SLOT_SIZE * 2];
        memcpy(saved, flash_memory + AUDIO_SLOT_SIZE, sizeof(saved));
        for (unsigned slot = 1; slot <= 2; ++slot) {
            erase_flash(slot * AUDIO_SLOT_SIZE, AUDIO_SLOT_SIZE);
            write_flash(slot * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET, v1, sizeof(v1));
            write_flash(slot * AUDIO_SLOT_SIZE, &h, sizeof(h));
        }
        assert(audio_store_open(&store, ops));
        assert(!audio_store_load_model(&store, &restored));
        assert(audio_store_save_model(&store, &model)); /* registering again replaces it */
        assert(audio_store_open(&store, ops) && audio_store_load_model(&store, &restored));
        assert(memcmp(&model, &restored, sizeof(model)) == 0);
        memcpy(flash_memory + AUDIO_SLOT_SIZE, saved, sizeof(saved));
        assert(audio_store_open(&store, ops) && audio_store_load_model(&store, &restored));
    }
    /* A bit flip in the saved model is caught by the CRC. */
    {
        unsigned slot = store.valid[2] && store.record[2].generation > store.record[1].generation ? 2u : 1u;
        flash_memory[slot * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET + 40] ^= 4;
        assert(audio_store_open(&store, ops) && audio_store_load_model(&store, &restored)); /* the other copy */
        assert(memcmp(&model, &restored, sizeof(model)) == 0);
        flash_memory[slot * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET + 40] ^= 4;
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
    test_ring_wav(); test_storage();
    puts("PASS: ring/WAV, v2 model round trip, v1 and corrupt models rejected, power cuts, queue bounds, CRC");
    return 0;
}
