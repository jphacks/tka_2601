#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_app.h"
#include <stddef.h>
#include <stdint.h>

/* The wire contract of chime enrollment (Issue #62):
 *   GET /functions/v1/device/chime-enrollment
 *     {"contract_version":1,"paired":bool,"request_seq":int,"action":"start"|"cancel"|null}
 *   PUT /functions/v1/device/chime-enrollment-status
 *     {"handled_seq":int,"phase":P,"reason":R,"registered":bool}
 * Pure functions: no heap, no network, no dependency on the audio task. */
typedef enum { CHIME_ENROLL_PARSE_INVALID, CHIME_ENROLL_PARSE_UNPAIRED, CHIME_ENROLL_PARSE_OK } chime_enroll_parse_t;
typedef enum { CHIME_ENROLL_ACTION_NONE, CHIME_ENROLL_ACTION_START, CHIME_ENROLL_ACTION_CANCEL } chime_enroll_action_t;
typedef struct { uint32_t request_seq; chime_enroll_action_t action; } chime_enroll_request_t;
/* Strict: every field present once, wrong types, unknown contract versions and
 * trailing bytes are INVALID. Unpaired needs action null; its request_seq may
 * be an integer or null (not used). Paired needs an integer request_seq. */
chime_enroll_parse_t chime_enroll_parse(const uint8_t *json, size_t length, chime_enroll_request_t *out);

/* Reasons the contract allows. NONE is encoded as null. */
typedef enum {
    CHIME_REPORT_NONE, CHIME_REPORT_TOO_NOISY, CHIME_REPORT_TOO_SHORT, CHIME_REPORT_CLIPPED,
    CHIME_REPORT_NO_RECORDING, CHIME_REPORT_UNSTABLE, CHIME_REPORT_BACKGROUND_MATCHES, CHIME_REPORT_BUSY,
} chime_report_reason_t;
const char *chime_enroll_phase_name(audio_enroll_phase_t phase);
const char *chime_report_reason_name(chime_report_reason_t reason); /* NULL for NONE */
/* Null unless the phase is FAILED. A failure without a detector reason (a call
 * started or the capture had a gap) is reported as no_recording. */
chime_report_reason_t chime_enroll_report_reason(audio_enroll_phase_t phase, chime_reason_t reason);
/* Returns the length, or 0 when the buffer is too small or an argument is out of range. */
size_t chime_enroll_status_encode(char *out, size_t capacity, uint32_t handled_seq, audio_enroll_phase_t phase,
                                  chime_report_reason_t reason, bool registered);
#ifdef __cplusplus
}
#endif
