#include "audio_store.h"
#include <math.h>
#include <stddef.h>
#include <string.h>

#define STORE_MAGIC 0x41554431u
#define TYPE_FORMAT 1u
#define TYPE_MODEL 2u
#define TYPE_EVENT 3u
_Static_assert(sizeof(audio_record_t) == 64, "Stable flash record format required");

static bool valid_header(const audio_record_t *h, unsigned slot)
{
    if (h->magic != STORE_MAGIC || h->version != 1 ||
        h->header_crc != audio_crc32(h, offsetof(audio_record_t, header_crc))) return false;
    if (slot == 0) return h->type == TYPE_FORMAT && h->length == 0;
    if (slot < AUDIO_EVENT_FIRST_SLOT) return h->type == TYPE_MODEL && h->length == sizeof(audio_model_t);
    return h->type == TYPE_EVENT && h->samples > 0 && h->samples <= AUDIO_CLIP_SAMPLES &&
           h->length == h->samples * 2 && isfinite(h->score);
}

bool audio_store_open(audio_store_t *s, audio_flash_t flash)
{
    memset(s, 0, sizeof(*s)); s->flash = flash;
    for (unsigned i = 0; i < AUDIO_SLOT_COUNT; ++i) {
        if (!flash.read(i * AUDIO_SLOT_SIZE, &s->record[i], sizeof(audio_record_t))) return false;
        s->valid[i] = valid_header(&s->record[i], i);
    }
    s->ready = s->valid[0];
    return s->ready;
}

static bool commit(audio_store_t *s, unsigned slot, audio_record_t *h, const void *payload)
{
    uint32_t base = slot * AUDIO_SLOT_SIZE;
    if (!s->flash.erase(base, AUDIO_SLOT_SIZE)) return false;
    s->valid[slot] = false;
    if (h->length && !s->flash.write(base + AUDIO_BODY_OFFSET, payload, h->length)) return false;
    h->magic = STORE_MAGIC; h->version = 1;
    h->crc = audio_crc32(payload, h->length);
    h->acknowledged = UINT32_MAX;
    h->header_crc = audio_crc32(h, offsetof(audio_record_t, header_crc));
    /* Commit header last: interrupted data writes cannot become playable records. */
    if (!s->flash.write(base, h, sizeof(*h))) return false;
    audio_record_t check;
    if (!s->flash.read(base, &check, sizeof(check)) || memcmp(&check, h, sizeof(check))) return false;
    s->record[slot] = *h;
    s->valid[slot] = true;
    if (!audio_store_verify(s, slot)) { s->valid[slot] = false; return false; }
    return true;
}

bool audio_store_format(audio_store_t *s)
{
    s->ready = false;
    /* Remove partition marker first; interrupted formatting always requires retry. */
    for (unsigned i = 0; i < AUDIO_SLOT_COUNT; ++i) {
        if (!s->flash.erase(i * AUDIO_SLOT_SIZE, AUDIO_SLOT_SIZE)) return false;
        s->valid[i] = false;
    }
    audio_record_t h = {.type = TYPE_FORMAT};
    s->ready = commit(s, 0, &h, NULL);
    return s->ready;
}

bool audio_store_verify(audio_store_t *s, unsigned slot)
{
    if (slot >= AUDIO_SLOT_COUNT || !s->valid[slot]) return false;
    uint8_t buffer[512]; uint32_t crc = UINT32_MAX;
    for (uint32_t offset = 0; offset < s->record[slot].length;) {
        uint32_t n = s->record[slot].length - offset;
        if (n > sizeof(buffer)) n = sizeof(buffer);
        if (!s->flash.read(slot * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET + offset, buffer, n)) return false;
        for (unsigned i = 0; i < n; ++i) {
            crc ^= buffer[i];
            for (unsigned j = 0; j < 8; ++j) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
        }
        offset += n;
    }
    return ~crc == s->record[slot].crc;
}

bool audio_store_load_model(audio_store_t *s, audio_model_t *m)
{
    if (!s->ready) return false;
    unsigned first = s->valid[2] && (!s->valid[1] || s->record[2].generation > s->record[1].generation) ? 2 : 1;
    for (unsigned attempt = 0; attempt < 2; ++attempt) {
        unsigned slot = attempt ? 3 - first : first;
        if (s->valid[slot] && audio_store_verify(s, slot) &&
            s->flash.read(slot * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET, m, sizeof(*m)) && audio_model_valid(m)) return true;
        /* Do not select a corrupt model as the old copy on the next save. */
        s->valid[slot] = false;
    }
    memset(m, 0, sizeof(*m)); return false;
}

bool audio_store_save_model(audio_store_t *s, const audio_model_t *m)
{
    if (!s->ready || !audio_model_valid(m)) return false;
    unsigned old = s->valid[2] && (!s->valid[1] || s->record[2].generation > s->record[1].generation) ? 2 : 1;
    audio_record_t h = {.type = TYPE_MODEL, .length = sizeof(*m),
                       .generation = s->valid[old] ? s->record[old].generation + 1 : 1};
    if (!h.generation) return false;
    return commit(s, 3 - old, &h, m);
}

bool audio_store_enqueue(audio_store_t *s, const int16_t *pcm, uint32_t samples,
                         const uint32_t id[4], float score)
{
    if (!s->ready || !samples || samples > AUDIO_CLIP_SAMPLES || !isfinite(score)) return false;
    for (unsigned slot = AUDIO_EVENT_FIRST_SLOT; slot < AUDIO_SLOT_COUNT; ++slot) {
        if (s->valid[slot] && s->record[slot].acknowledged != 0) continue;
        audio_record_t h = {.type = TYPE_EVENT, .length = samples * 2, .samples = samples, .score = score};
        memcpy(h.id, id, sizeof(h.id));
        return commit(s, slot, &h, pcm);
    }
    return false; /* never silently overwrite unacknowledged recordings */
}

int audio_store_pending(const audio_store_t *s)
{
    if (s->ready) for (unsigned i = AUDIO_EVENT_FIRST_SLOT; i < AUDIO_SLOT_COUNT; ++i)
        if (s->valid[i] && s->record[i].acknowledged != 0) return (int)i;
    return -1;
}
bool audio_store_read_audio(audio_store_t *s, unsigned slot, uint32_t offset, void *out, size_t length)
{
    if (!s->ready || slot < AUDIO_EVENT_FIRST_SLOT || slot >= AUDIO_SLOT_COUNT || !s->valid[slot] ||
        offset > s->record[slot].length || length > s->record[slot].length - offset) return false;
    return s->flash.read(slot * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET + offset, out, length);
}
bool audio_store_ack(audio_store_t *s, unsigned slot)
{
    uint32_t zero = 0, readback = UINT32_MAX;
    if (!s->ready || slot < AUDIO_EVENT_FIRST_SLOT || slot >= AUDIO_SLOT_COUNT || !s->valid[slot]) return false;
    uint32_t addr = slot * AUDIO_SLOT_SIZE + offsetof(audio_record_t, acknowledged);
    if (!s->flash.write(addr, &zero, sizeof(zero)) || !s->flash.read(addr, &readback, sizeof(readback)) || readback) return false;
    s->record[slot].acknowledged = 0; return true;
}
