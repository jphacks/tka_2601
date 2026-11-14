#pragma once
#include "audio_core.h"

#define AUDIO_SLOT_SIZE (256u * 1024u)
#define AUDIO_SLOT_COUNT 8u
#define AUDIO_STORE_BYTES (AUDIO_SLOT_SIZE * AUDIO_SLOT_COUNT)
#define AUDIO_BODY_OFFSET 256u
#define AUDIO_EVENT_FIRST_SLOT 3u

typedef struct {
    uint32_t magic, version, type, generation, length, crc, samples;
    uint32_t id[4];
    float score;
    uint32_t header_crc, acknowledged, reserved[2];
} audio_record_t;
typedef struct {
    bool (*read)(uint32_t offset, void *out, size_t length);
    bool (*write)(uint32_t offset, const void *data, size_t length);
    bool (*erase)(uint32_t offset, size_t length);
} audio_flash_t;
typedef struct {
    audio_flash_t flash;
    bool ready;
    audio_record_t record[AUDIO_SLOT_COUNT];
    bool valid[AUDIO_SLOT_COUNT];
} audio_store_t;

/* All offsets are relative to a dedicated 2 MiB partition. Caller serializes access. */
bool audio_store_open(audio_store_t *s, audio_flash_t flash);
bool audio_store_format(audio_store_t *s); /* explicit user operation only */
bool audio_store_load_model(audio_store_t *s, audio_model_t *model);
bool audio_store_save_model(audio_store_t *s, const audio_model_t *model);
bool audio_store_enqueue(audio_store_t *s, const int16_t *pcm, uint32_t samples,
                         const uint32_t id[4], float score);
int audio_store_pending(const audio_store_t *s);
bool audio_store_read_audio(audio_store_t *s, unsigned slot, uint32_t offset, void *out, size_t length);
bool audio_store_verify(audio_store_t *s, unsigned slot);
bool audio_store_ack(audio_store_t *s, unsigned slot);
