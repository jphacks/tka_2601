#pragma once
#include "voice_protocol.h"

/* Only the cloud leg uses JSON + raw PCM. The M5 leg stays DVS1. */
typedef struct {
    uint32_t session, input_turn, input_frames;
    uint32_t output_turn, output_frames, output_samples;
    bool started, ready, input_active, output_active, output_complete;
    /* Existing GitHub /api/relay: ready + PCM + agent_state/transcript.
     * Explicit opt-in preserves the strict v2 decoder for v2 clients. */
    bool allow_legacy, legacy, call_started, speaking, closing, waiting_reply, no_reply;
    bool listening, thinking;
    uint8_t pending_control;
    uint16_t pending_length;
    uint8_t pending_audio[640];
    uint32_t clock_ms, last_audio_ms, listening_ms, last_input_ms, input_end_ms;
} voice_relay_t;

bool voice_relay_settings_valid(const char *mode, const char *device_key);
bool voice_relay_encode(voice_relay_t *relay, const voice_header_t *header,
    const void *payload, const char *visit_id, const char *mode, const char *device_key,
    uint8_t *wire, size_t capacity, size_t *length, uint8_t *opcode);
/* 1 actionable packet, 0 informational JSON, -1 invalid/incompatible message. */
int voice_relay_decode(voice_relay_t *relay, uint8_t opcode,
    const uint8_t *wire, size_t length, voice_header_t *header, uint8_t *payload);
/* Drain synthetic M5 framing only after agent listening + a 500ms tail, and
 * wait for actual M5 playback completion before permitting the next input. */
int voice_relay_pending(voice_relay_t *relay, uint32_t now_ms,
    voice_header_t *header, uint8_t *payload);
