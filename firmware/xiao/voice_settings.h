#pragma once
/* Non-secret tuning; API hostname/key live in api_config.h. */
#ifndef VOICE_STREAM_ENABLED
#define VOICE_STREAM_ENABLED 1
#endif
#ifndef VOICE_STREAM_PATH
#define VOICE_STREAM_PATH "/api/relay"
#endif
// The deployed server explicitly advertises ready/protocol_version:2.
// V2 submits a completed utterance directly to ASR, without a second VAD.
// Set to 1 only for older servers without version 2 support (docs/spec.md 5.4).
#ifndef VOICE_RELAY_PROTOCOL
#define VOICE_RELAY_PROTOCOL 2
#endif
#ifndef VOICE_RMS_GATE
#define VOICE_RMS_GATE 600u
#endif
/* docs/spec.md 5.1: no microphone audio during playback and for 0.5 s after it. */
#define VOICE_SETTLE_MS 500u
#define VOICE_RESPONSE_TIMEOUT_MS 90000u
#define VOICE_IDLE_TIMEOUT_MS 60000u
/* docs/spec.md 2.2 / 5.1: leave time to end the intercom before its own limit. */
#define VOICE_CALL_TIMEOUT_MS 50000u
#define VOICE_CHIME_COOLDOWN_MS 20000u

/* Automatic recovery after an unproven intercom stop: retry delay doubles up to the cap. */
#define VOICE_RECOVERY_RETRY_MIN_MS 10000u
#define VOICE_RECOVERY_RETRY_MAX_MS 30000u
/* One END press takes at most 2 s hold + 3 s return; this bounds a stalled servo. */
#define VOICE_RECOVERY_CONFIRM_MS 15000u
/* Failed attempts are logged at most this often (the first one always is). */
#define VOICE_RECOVERY_LOG_MS 60000u
