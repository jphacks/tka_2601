#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "voice_protocol.h"
#include "relay_protocol.h"
#include "net_stream.h"

typedef struct {
    net_stream_t *socket;
    bool websocket, fragmented, final, diagnostic;
    uint8_t opcode, message_opcode, frame_header[4], frame[VOICE_PACKET], message[VOICE_PACKET];
    size_t header_used, frame_used, frame_length, message_used;
    uint32_t progress;
    voice_relay_t relay;
} voice_transport_t;
typedef struct { voice_header_t header; uint8_t payload[VOICE_PAYLOAD]; } voice_packet_t;
void voice_transport_init(voice_transport_t *link);
bool voice_transport_server(voice_transport_t *link);
void voice_transport_close(voice_transport_t *link);
bool voice_transport_legacy(const voice_transport_t *link);
bool voice_transport_send(voice_transport_t *link, const voice_header_t *header, const void *payload);
/* 1 packet, 0 incomplete/no data, -1 closed or malformed. */
int voice_transport_poll(voice_transport_t *link, voice_packet_t *packet);
#ifdef __cplusplus
}
#endif
