#pragma once
/* Non-secret tuning; API hostname/key and M5 address/token use existing settings. */
#ifndef VOICE_STREAM_ENABLED
#define VOICE_STREAM_ENABLED 1
#endif
#ifndef VOICE_STREAM_PATH
#define VOICE_STREAM_PATH "/api/relay"
#endif
// The deployed server now explicitly advertises ready/protocol_version:2.
// V2 submits a completed utterance directly to ASR, without a second VAD.
// Set to 1 only for older servers without version 2 support.
#ifndef VOICE_RELAY_PROTOCOL
#define VOICE_RELAY_PROTOCOL 2
#endif
#ifndef VOICE_RMS_GATE
#define VOICE_RMS_GATE 600u
#endif
#define VOICE_SETTLE_MS 250u
#define VOICE_RESPONSE_TIMEOUT_MS 90000u
#define VOICE_IDLE_TIMEOUT_MS 60000u
#define VOICE_CALL_TIMEOUT_MS 600000u
