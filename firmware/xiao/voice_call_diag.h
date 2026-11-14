#pragma once
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Numeric only. Times are uint32 millis() on the call's boot, not wall clock.
 * started: physicalCALL/50s timer start; greeting: first received PCM;
 * input_end: last accepted local utterance end; ended: cleanup entry.
 * input_frames is cumulative successful PCM sends in this call. input_end_sent
 * is1 only after an actual v2INPUT_END message, not legacy's no-wire endpoint. */
typedef struct {
 uint32_t reason,phase,turn,input_frames,input_end_sent;
 uint32_t started_ms,greeting_ms,input_end_ms,ended_ms;
} voice_call_diag_t;
uint32_t voice_call_diag_reason(const char *reason);
bool voice_call_diag_store(const voice_call_diag_t *snapshot);
bool voice_call_diag_command(const char *command);
#ifdef __cplusplus
}
#endif
