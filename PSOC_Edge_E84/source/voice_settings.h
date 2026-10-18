#pragma once
/* Non-secret tuning; API hostname/key and M5 address/token use existing settings. */
#ifndef VOICE_STREAM_ENABLED
#define VOICE_STREAM_ENABLED 1
#endif
#ifndef VOICE_STREAM_PATH
#define VOICE_STREAM_PATH "/api/relay"
#endif
// 1 matches GitHub backend/voice-agent and the currently deployed server.
// Set to 2 only when that server explicitly supports protocol_version:2.
#ifndef VOICE_RELAY_PROTOCOL
#define VOICE_RELAY_PROTOCOL 1
#endif
#ifndef VOICE_RMS_GATE
#define VOICE_RMS_GATE 600u
#endif
#define VOICE_SETTLE_MS 250u
#define VOICE_RESPONSE_TIMEOUT_MS 90000u
#define VOICE_IDLE_TIMEOUT_MS 60000u
#define VOICE_CALL_TIMEOUT_MS 600000u
