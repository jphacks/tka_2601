/* KIT_PSE84_AI left XENSIV PDM microphone, PDM0 channel 2.
 * API/configuration references:
 * https://github.com/Infineon/mtb-example-psoc-edge-pdm-pcm
 * https://github.com/Infineon/TARGET_KIT_PSE84_AI
 * Uses the E84 device support library, not the PSOC 6 cyhal_pdm_pcm API. */
#include "e84_audio_hw.h"
#include "cy_pdl.h"
#include "cybsp.h"
#include "FreeRTOS.h"
#include "queue.h"
#include "task.h"
#include <string.h>

#define MICROPHONE_CHANNEL 2u
#define FRAME_QUEUE_LENGTH 8u
#define PDM_FIFO_CAPACITY 64u
#define PDM_ERROR_MASK (CY_PDM_PCM_INTR_RX_FIR_OVERFLOW | \
    CY_PDM_PCM_INTR_RX_OVERFLOW | CY_PDM_PCM_INTR_RX_IF_OVERFLOW | \
    CY_PDM_PCM_INTR_RX_UNDERFLOW)

/* FreeRTOS FromISR functions must run at a syscall-safe priority. */
#ifndef E84_AUDIO_IRQ_PRIORITY
#define E84_AUDIO_IRQ_PRIORITY 6u
#endif
#if defined(configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY) && \
    E84_AUDIO_IRQ_PRIORITY < configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY
#error "E84_AUDIO_IRQ_PRIORITY must permit FreeRTOS FromISR calls"
#endif
#ifndef E84_AUDIO_PDM_GAIN
#define E84_AUDIO_PDM_GAIN CY_PDM_PCM_SEL_GAIN_17DB
#endif

static const cy_stc_sysint_t microphone_irq = {
    .intrSrc = (IRQn_Type)CYBSP_PDM_CHANNEL_2_IRQ,
    .intrPriority = E84_AUDIO_IRQ_PRIORITY,
};
static QueueHandle_t frame_queue;
static e84_audio_frame_t assembling;
static uint32_t assembled_samples;
static uint32_t capture_sequence;
static uint32_t capture_errors;
static uint32_t capture_drops;
static bool capture_running;

static void microphone_interrupt(void)
{
    BaseType_t wake = pdFALSE;
    uint32_t status = Cy_PDM_PCM_Channel_GetInterruptStatusMasked(
        PDM0, MICROPHONE_CHANNEL);

    if ((status & PDM_ERROR_MASK) != 0u) {
        /* Discard the partial frame and every sample present when the fault
         * occurred. Never combine audio from opposite sides of an overflow. */
        ++capture_errors;
        ++capture_sequence;
        assembled_samples = 0u;
        uint32_t count = Cy_PDM_PCM_Channel_GetNumInFifo(PDM0, MICROPHONE_CHANNEL);
        if (count > PDM_FIFO_CAPACITY) count = PDM_FIFO_CAPACITY;
        for (uint32_t i = 0; i < count; ++i)
            (void)Cy_PDM_PCM_Channel_ReadFifo(PDM0, MICROPHONE_CHANNEL);
    } else if ((status & CY_PDM_PCM_INTR_RX_TRIGGER) != 0u) {
        /* Read the actual occupancy, not an assumed interrupt batch size.
         * Bound ISR work even if the microphone continues producing samples. */
        uint32_t count = Cy_PDM_PCM_Channel_GetNumInFifo(PDM0, MICROPHONE_CHANNEL);
        if (count > PDM_FIFO_CAPACITY) count = PDM_FIFO_CAPACITY;
        for (uint32_t i = 0; i < count; ++i) {
            assembling.pcm[assembled_samples++] = (int16_t)
                Cy_PDM_PCM_Channel_ReadFifo(PDM0, MICROPHONE_CHANNEL);
            if (assembled_samples == E84_AUDIO_FRAME_SAMPLES) {
                assembling.sequence = ++capture_sequence;
                assembling.errors = capture_errors;
                assembling.drops = capture_drops;
                /* Queue copies the whole frame before this buffer is reused. */
                if (xQueueSendFromISR(frame_queue, &assembling, &wake) != pdPASS)
                    ++capture_drops;
                assembled_samples = 0u;
            }
        }
    }
    /* Only acknowledge bits observed on entry, preserving a newly raised
     * different error for the following interrupt. */
    Cy_PDM_PCM_Channel_ClearInterrupt(PDM0, MICROPHONE_CHANNEL, status);
    portYIELD_FROM_ISR(wake);
}

cy_rslt_t e84_audio_capture_start(void)
{
    if (capture_running) return CY_RSLT_SUCCESS;
    if (frame_queue == NULL) {
        frame_queue = xQueueCreate(FRAME_QUEUE_LENGTH, sizeof(e84_audio_frame_t));
        if (frame_queue == NULL)
            return CY_RSLT_CREATE(CY_RSLT_TYPE_ERROR, CY_RSLT_MODULE_USER_BASE, 1u);
    }
    (void)xQueueReset(frame_queue);
    memset(&assembling, 0, sizeof(assembling));
    assembled_samples = capture_sequence = capture_errors = capture_drops = 0u;

    /* BSP default: 16-bit, CIC /32, FIR1 /3, 1.536 MHz PDM clock => 16 kHz.
     * No CPU, SDIO, USB, or shared PLL clocks are changed here. */
    cy_en_pdm_pcm_status_t result = Cy_PDM_PCM_Init(PDM0, &CYBSP_PDM_config);
    if (result != CY_PDM_PCM_SUCCESS) return (cy_rslt_t)result;
    Cy_PDM_PCM_Channel_Enable(PDM0, MICROPHONE_CHANNEL);
    result = Cy_PDM_PCM_Channel_Init(PDM0, &channel_2_config, MICROPHONE_CHANNEL);
    if (result != CY_PDM_PCM_SUCCESS) {
        Cy_PDM_PCM_Channel_Disable(PDM0, MICROPHONE_CHANNEL);
        return (cy_rslt_t)result;
    }
    result = Cy_PDM_PCM_SetGain(PDM0, MICROPHONE_CHANNEL, E84_AUDIO_PDM_GAIN);
    if (result != CY_PDM_PCM_SUCCESS) {
        Cy_PDM_PCM_Channel_Disable(PDM0, MICROPHONE_CHANNEL);
        return (cy_rslt_t)result;
    }
    uint32_t stale = Cy_PDM_PCM_Channel_GetNumInFifo(PDM0, MICROPHONE_CHANNEL);
    if (stale > PDM_FIFO_CAPACITY) stale = PDM_FIFO_CAPACITY;
    for (uint32_t i = 0; i < stale; ++i)
        (void)Cy_PDM_PCM_Channel_ReadFifo(PDM0, MICROPHONE_CHANNEL);
    Cy_PDM_PCM_Channel_SetInterruptMask(PDM0, MICROPHONE_CHANNEL, 0u);
    Cy_PDM_PCM_Channel_ClearInterrupt(PDM0, MICROPHONE_CHANNEL, CY_PDM_PCM_INTR_MASK);
    cy_en_sysint_status_t irq_result = Cy_SysInt_Init(&microphone_irq, microphone_interrupt);
    if (irq_result != CY_SYSINT_SUCCESS) {
        Cy_PDM_PCM_Channel_Disable(PDM0, MICROPHONE_CHANNEL);
        return (cy_rslt_t)irq_result;
    }
    NVIC_ClearPendingIRQ(microphone_irq.intrSrc);
    Cy_PDM_PCM_Channel_SetInterruptMask(PDM0, MICROPHONE_CHANNEL,
        CY_PDM_PCM_INTR_RX_TRIGGER | PDM_ERROR_MASK);
    capture_running = true;
    NVIC_EnableIRQ(microphone_irq.intrSrc);
    Cy_PDM_PCM_Activate_Channel(PDM0, MICROPHONE_CHANNEL);
    return CY_RSLT_SUCCESS;
}

bool e84_audio_read(e84_audio_frame_t *frame, uint32_t timeout_ms)
{
    if (!capture_running || frame == NULL) return false;
    return xQueueReceive(frame_queue, frame, pdMS_TO_TICKS(timeout_ms)) == pdPASS;
}

void e84_audio_capture_stop(void)
{
    if (!capture_running) return;
    NVIC_DisableIRQ(microphone_irq.intrSrc);
    Cy_PDM_PCM_Channel_SetInterruptMask(PDM0, MICROPHONE_CHANNEL, 0u);
    Cy_PDM_PCM_DeActivate_Channel(PDM0, MICROPHONE_CHANNEL);
    Cy_PDM_PCM_Channel_Disable(PDM0, MICROPHONE_CHANNEL);
    Cy_PDM_PCM_Channel_ClearInterrupt(PDM0, MICROPHONE_CHANNEL, CY_PDM_PCM_INTR_MASK);
    NVIC_ClearPendingIRQ(microphone_irq.intrSrc);
    capture_running = false;
    assembled_samples = 0u;
    (void)xQueueReset(frame_queue);
}
