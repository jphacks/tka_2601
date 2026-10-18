#pragma once
#include "voice_protocol.h"

/* Only the cloud leg uses JSON + raw PCM. The M5 leg stays DVS1. */
typedef struct {
    uint32_t session, input_turn, input_frames;
    uint32_t output_turn, output_frames, output_samples;
    bool started, ready, input_active, output_active, output_complete;
} voice_relay_t;

bool voice_relay_settings_valid(const char *mode, const char *device_key);
bool voice_relay_encode(voice_relay_t *relay, const voice_header_t *header,
    const void *payload, const char *visit_id, const char *mode, const char *device_key,
    uint8_t *wire, size_t capacity, size_t *length, uint8_t *opcode);
/* 1 actionable packet, 0 informational JSON, -1 invalid/incompatible message. */
int voice_relay_decode(voice_relay_t *relay, uint8_t opcode,
    const uint8_t *wire, size_t length, voice_header_t *header, uint8_t *payload);
