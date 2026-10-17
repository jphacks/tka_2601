#ifndef E84_AUDIO_HW_H
#define E84_AUDIO_HW_H

#include "cy_result.h"
#include <stdbool.h>
#include <stdint.h>

#define E84_AUDIO_SAMPLE_RATE 16000u
#define E84_AUDIO_FRAME_SAMPLES 320u

/* A complete 20 ms frame. A sequence gap or changed errors means that audio
 * was lost; the application must abandon any in-progress detection/clip. */
typedef struct {
    int16_t pcm[E84_AUDIO_FRAME_SAMPLES];
    uint32_t sequence;
    uint32_t errors;
    uint32_t drops;
} e84_audio_frame_t;

/* Call from the CM55 audio task after cybsp_init(). The standard KIT_PSE84_AI
 * BSP provides the 16 kHz clock and P8.5/P8.6 pin configuration. Only this
 * core may own PDM0. Start/stop/read must have one task-level caller. */
cy_rslt_t e84_audio_capture_start(void);
bool e84_audio_read(e84_audio_frame_t *frame, uint32_t timeout_ms);
void e84_audio_capture_stop(void);

#endif
