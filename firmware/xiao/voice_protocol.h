#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VOICE_PAYLOAD 1280u
#define VOICE_PACKET 1304u /* largest accepted WebSocket message */
enum voice_type {
    VOICE_HELLO=1, VOICE_READY, VOICE_CALL_START, VOICE_CALL_STARTED,
    VOICE_INPUT_START, VOICE_INPUT_AUDIO, VOICE_INPUT_END, VOICE_OUTPUT_START,
    VOICE_OUTPUT_AUDIO, VOICE_OUTPUT_END, VOICE_PLAYBACK_DONE, VOICE_LISTEN,
    VOICE_CALL_END, VOICE_CALL_ENDED, VOICE_CANCEL, VOICE_ERROR,
    VOICE_PING, VOICE_PONG, VOICE_NO_REPLY, VOICE_AUDIO_ACK
};
typedef struct {
    uint8_t type, flags;
    uint32_t session, turn, sequence, length;
} voice_header_t;
/* In-process call events; these are never sent as binary headers. */
bool voice_header_valid(const voice_header_t *header);

/* Validate an RFC6455 server frame header; extensions/masking aren't negotiated.
 * Returns header bytes, 0 for incomplete, -1 for invalid/oversized. */
int voice_ws_header(const uint8_t *data, size_t size, uint8_t *opcode,
                    bool *final, size_t *payload);
bool voice_ws_upgrade_valid(const char *headers, const char *expected_accept);
#ifdef __cplusplus
}
#endif
