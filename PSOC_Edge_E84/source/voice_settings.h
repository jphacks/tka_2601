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
/* Automatic M5 recovery after an unproven stop: retry delay doubles up to the cap. */
#define VOICE_RECOVERY_RETRY_MIN_MS 10000u
#define VOICE_RECOVERY_RETRY_MAX_MS 30000u
/* A fresh-session CANCEL is answered immediately; this only bounds a stalled M5. */
#define VOICE_RECOVERY_CONFIRM_MS 15000u
/* Failed attempts are logged at most this often (the first one always is). */
#define VOICE_RECOVERY_LOG_MS 60000u
