#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdint.h>

/* Bench-tuned values, kept in NVS and applied immediately. */
void tune_begin(void);
void tune_command(const char *command); /* "@tune ..." */
uint32_t tune_speaker_volume(void);     /* percent, 0..100 */
uint32_t tune_voice_gate(void);         /* speech start RMS, 30..32767 */
uint32_t tune_chime_margin(void);       /* percent of the enrolled threshold, 50..200 */
#ifdef __cplusplus
}
#endif
