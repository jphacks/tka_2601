#include "audio_app.h"
#include "audio_core.h"
#include "audio_store.h"
#include "audio_upload.h"
#include "cybsp.h"
#include "cyhal.h"
#include "cy_retarget_io.h"
#include "cy_serial_flash_qspi.h"
#include "cycfg_qspi_memslot.h"
#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"
#include "mbedtls/entropy.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

typedef struct { int16_t pcm[AUDIO_FRAME]; uint32_t sequence; } frame_t;
typedef enum { JOB_MODEL, JOB_CLIP, JOB_FORMAT } job_t;
static QueueHandle_t frames, commands, jobs;
static cyhal_pdm_pcm_t microphone;
static cyhal_clock_t mic_clock;
static frame_t capture[2];
static unsigned capture_index;
static uint32_t capture_sequence;
static volatile uint32_t capture_drops, capture_errors;
static volatile bool connected, clip_busy, model_busy, formatting;
static bool flash_available;
static uint32_t flash_base;
static audio_store_t store;
static audio_model_t model, enrolling, model_to_save;
static audio_dsp_t dsp;
static audio_ring_t ring_buffer;
static audio_pattern_t candidate;
static int16_t pending_pcm[AUDIO_CLIP_SAMPLES];
static uint32_t pending_samples;
static float pending_score;

void audio_network_ready(bool ready) { connected = ready; }

static bool flash_read(uint32_t off, void *out, size_t n)
{
    return off <= AUDIO_STORE_BYTES && n <= AUDIO_STORE_BYTES - off &&
           cy_serial_flash_qspi_read(flash_base + off, n, out) == CY_RSLT_SUCCESS;
}
static bool flash_write(uint32_t off, const void *data, size_t n)
{
    return off <= AUDIO_STORE_BYTES && n <= AUDIO_STORE_BYTES - off &&
           cy_serial_flash_qspi_write(flash_base + off, n, data) == CY_RSLT_SUCCESS;
}
static bool flash_erase(uint32_t off, size_t n)
{
    return off <= AUDIO_STORE_BYTES && n <= AUDIO_STORE_BYTES - off &&
           cy_serial_flash_qspi_erase(flash_base + off, n) == CY_RSLT_SUCCESS;
}

static void microphone_event(void *arg, cyhal_pdm_pcm_event_t event)
{
    (void)arg;
    BaseType_t wake = pdFALSE;
    if (event & CYHAL_PDM_PCM_RX_OVERFLOW) ++capture_errors;
    if (event & CYHAL_PDM_PCM_ASYNC_COMPLETE) {
        unsigned done = capture_index;
        capture[done].sequence = ++capture_sequence;
        capture_index ^= 1u;
        if (cyhal_pdm_pcm_read_async(&microphone, capture[capture_index].pcm, AUDIO_FRAME) != CY_RSLT_SUCCESS)
            ++capture_errors;
        if (xQueueSendFromISR(frames, &capture[done], &wake) != pdPASS) ++capture_drops;
    }
    portYIELD_FROM_ISR(wake);
}

static cy_rslt_t microphone_start(void)
{
    /* Existing BSP PLL0 is 48 MHz. Keep CPU, SDIO and USB clocks untouched.
       48 MHz / (3 * 10) / 100 = exactly 16 kHz, PDM clock = 1.6 MHz. */
    if (cyhal_clock_get_frequency(&CYHAL_CLOCK_PLL[0]) != 48000000u) return CYHAL_PDM_PCM_RSLT_ERR_INVALID_CONFIG_PARAM;
    cy_rslt_t r = cyhal_clock_reserve(&mic_clock, &CYHAL_CLOCK_HF[1]);
    if (r == CY_RSLT_SUCCESS) r = cyhal_clock_set_source(&mic_clock, &CYHAL_CLOCK_PLL[0]);
    if (r == CY_RSLT_SUCCESS) r = cyhal_clock_set_divider(&mic_clock, 1);
    if (r == CY_RSLT_SUCCESS) r = cyhal_clock_set_enabled(&mic_clock, true, true);
    const cyhal_pdm_pcm_cfg_t config = {.sample_rate = AUDIO_RATE, .decimation_rate = 100,
        .mode = CYHAL_PDM_PCM_MODE_LEFT, .word_length = 16, .left_gain = 0, .right_gain = 0};
    if (r == CY_RSLT_SUCCESS) r = cyhal_pdm_pcm_init(&microphone, CYBSP_PDM_DATA, CYBSP_PDM_CLK, &mic_clock, &config);
    if (r != CY_RSLT_SUCCESS) return r;
    cyhal_pdm_pcm_register_callback(&microphone, microphone_event, NULL);
    cyhal_pdm_pcm_enable_event(&microphone,
        CYHAL_PDM_PCM_ASYNC_COMPLETE | CYHAL_PDM_PCM_RX_OVERFLOW, 5, true);
    r = cyhal_pdm_pcm_start(&microphone);
    if (r == CY_RSLT_SUCCESS) r = cyhal_pdm_pcm_read_async(&microphone, capture[0].pcm, AUDIO_FRAME);
    return r;
}

static void submit_clip(uint32_t wanted_samples, float score)
{
    if (clip_busy || formatting) {
        printf("[AUDIO] Recording dropped: previous recording is still being saved.\n"); return;
    }
    pending_samples = audio_ring_copy(&ring_buffer, pending_pcm, wanted_samples);
    pending_score = score;
    clip_busy = true;
    job_t job = JOB_CLIP;
    if (xQueueSend(jobs, &job, 0) != pdPASS) {
        clip_busy = false; printf("[AUDIO] Recording dropped: storage job queue is full.\n");
    }
}

static void audio_task(void *arg)
{
    (void)arg;
    audio_dsp_init(&dsp);
    cy_rslt_t result = microphone_start();
    if (result != CY_RSLT_SUCCESS) {
        printf("[AUDIO] Microphone initialization failed: 0x%08lx.\n", (unsigned long)result);
        vTaskDelete(NULL); return;
    }
    printf("[AUDIO] PDM capture started: 16000 Hz, signed 16-bit, mono.\n");
    printf("[AUDIO] Enter h for commands. Registration: e + Enter.\n");
    enum { NORMAL, NOISE, ENROLL, VERIFY } mode = NORMAL;
    unsigned warmup = 50, noise_frames = 0, quiet = 0, clipped = 0, reject_until_quiet = 0;
    unsigned post = 0, clip_frames = 0, manual = 0;
    uint32_t previous_sequence = 0, observed_errors = 0;
    float noise_sum = 0, score = 0, last_rms = 0;
    frame_t frame;
    for (;;) {
        char command;
        if (xQueueReceive(commands, &command, 0) == pdPASS) {
            if (command == 'e' && !model_busy && !formatting && flash_available && store.ready) {
                memset(&enrolling, 0, sizeof(enrolling));
                mode = NOISE; noise_frames = 0; noise_sum = 0; candidate.length = 0;
                post = manual = 0;
                printf("[SETUP] Keep quiet for 5 seconds. Measuring background noise.\n");
            } else if (command == 'x') {
                mode = NORMAL; candidate.length = 0; post = manual = 0;
                printf("[SETUP] Registration cancelled; active model is unchanged.\n");
            } else if (command == 'r' && !clip_busy && !formatting) {
                mode = NORMAL; candidate.length = 0; post = 0; manual = 250;
                printf("[AUDIO] Manual recording started (5 seconds).\n");
            } else if (command == 'F' && !clip_busy && !model_busy && !formatting && flash_available) {
                formatting = true; mode = NORMAL; candidate.length = 0; post = manual = 0;
                memset(&model, 0, sizeof(model));
                job_t job = JOB_FORMAT;
                if (xQueueSend(jobs, &job, 0) != pdPASS) formatting = false;
            } else if (command == 's') {
                printf("[AUDIO] model=%s threshold=%.3f gate=%.0f rms=%.0f drops=%lu errors=%lu upload=%s\n",
                    audio_model_valid(&model) ? "registered" : "none", (double)model.threshold,
                    (double)model.gate_rms, (double)last_rms, (unsigned long)capture_drops, (unsigned long)capture_errors,
                    audio_upload_configured() ? "configured" : "disabled");
            } else if (command != 'h') printf("[AUDIO] Command unavailable; check storage initialization/busy state.\n");
        }
        if (xQueueReceive(frames, &frame, pdMS_TO_TICKS(1000)) != pdPASS) {
            printf("[AUDIO] No microphone frames received; detection is unavailable. Reset to retry.\n");
            continue;
        }
        bool gap = (previous_sequence && frame.sequence != previous_sequence + 1) || capture_errors != observed_errors;
        previous_sequence = frame.sequence; observed_errors = capture_errors;
        if (gap) {
            candidate.length = 0; post = manual = 0; ring_buffer.used = 0; reject_until_quiet = 50;
            if (mode != NORMAL) { mode = NORMAL; printf("[SETUP] Capture gap; registration cancelled.\n"); }
            printf("[AUDIO] Capture gap; incomplete candidate/recording discarded.\n");
        }
        if (warmup) { --warmup; continue; }
        audio_ring_push(&ring_buffer, frame.pcm, AUDIO_FRAME);
        if (formatting) continue;
        if (manual) { if (--manual == 0) submit_clip(5u * AUDIO_RATE, -1.0f); continue; }
        if (post) {
            if (--post == 0) {
                submit_clip(clip_frames * AUDIO_FRAME, score);
                reject_until_quiet = 50;
            }
            continue;
        }
        audio_feature_t feature;
        float rms = audio_feature(&dsp, frame.pcm, &feature);
        last_rms = rms;
        if (mode == NOISE) {
            noise_sum += rms;
            if (++noise_frames == 250) {
                enrolling.gate_rms = fmaxf(80.0f, noise_sum / noise_frames * 4.0f);
                if (enrolling.gate_rms > 16000) { mode = NORMAL; printf("[SETUP] Too noisy; retry in a quieter setting.\n"); continue; }
                mode = ENROLL; quiet = 0; reject_until_quiet = 0;
                printf("[SETUP] Ring the intercom once (1/3). Gate=%.0f.\n", (double)enrolling.gate_rms);
            }
            continue;
        }
        float gate = mode == NORMAL ? model.gate_rms : enrolling.gate_rms;
        if (mode == NORMAL && !audio_model_valid(&model)) continue;
        bool loud = rms >= gate;
        if (reject_until_quiet) {
            if (loud) reject_until_quiet = 50;
            else --reject_until_quiet;
            continue;
        }
        if (!candidate.length && !loud) continue;
        if (!candidate.length) { quiet = 0; clipped = 0; }
        for (unsigned i = 0; i < AUDIO_FRAME; ++i)
            if (frame.pcm[i] >= 32700 || frame.pcm[i] <= -32700) ++clipped;
        if (!loud) memset(&feature, 0, sizeof(feature));
        if (candidate.length == AUDIO_MAX_FRAMES + AUDIO_END_FRAMES ||
            (loud && candidate.length >= AUDIO_MAX_FRAMES)) {
            candidate.length = 0; reject_until_quiet = 50;
            printf("[AUDIO] Candidate longer than 4 seconds; ignored.\n"); continue;
        }
        candidate.frame[candidate.length++] = feature;
        quiet = loud ? 0 : quiet + 1;
        if (quiet < AUDIO_END_FRAMES) continue;
        candidate.length -= quiet;
        if (candidate.length < 10 || clipped > candidate.length * AUDIO_FRAME / 100) {
            candidate.length = 0; printf("[AUDIO] Candidate too short or clipped; ignored.\n"); continue;
        }
        if (mode == ENROLL) {
            enrolling.pattern[enrolling.count++] = candidate;
            if (enrolling.count == AUDIO_TEMPLATES) {
                if (audio_calibrate(&enrolling)) {
                    mode = VERIFY; printf("[SETUP] Three recordings agree. Ring once more to verify.\n");
                } else {
                    mode = NORMAL; printf("[SETUP] Recordings differ too much. Enter e to start again.\n");
                }
            } else printf("[SETUP] Recorded. Ring once again (%lu/3).\n", (unsigned long)enrolling.count + 1);
        } else if (mode == VERIFY) {
            float distance = audio_match(&enrolling, &candidate);
            if (distance <= enrolling.threshold && !model_busy) {
                model = enrolling; model_to_save = enrolling; model_busy = true;
                job_t job = JOB_MODEL;
                if (xQueueSend(jobs, &job, 0) != pdPASS) { model_busy = false; printf("[SETUP] Persistence queue full; model is RAM-only.\n"); }
                mode = NORMAL; printf("[SETUP] Verification passed. Saving registered features.\n");
            } else printf("[SETUP] Verification did not match. Retry, or e to register again.\n");
        } else {
            score = audio_match(&model, &candidate);
            if (score <= model.threshold) {
                clip_frames = AUDIO_PRE_FRAMES + candidate.length + AUDIO_POST_FRAMES;
                post = AUDIO_POST_FRAMES - quiet;
                printf("[DETECTED] Doorbell, distance=%.3f. Capturing tail.\n", (double)score);
            }
        }
        candidate.length = 0;
    }
}

static void console_task(void *arg)
{
    (void)arg;
    char line[40]; unsigned n = 0; bool too_long = false;
    for (;;) {
        uint8_t c;
        if (cyhal_uart_readable(&cy_retarget_io_uart_obj) &&
            cyhal_uart_getc(&cy_retarget_io_uart_obj, &c, 1) == CY_RSLT_SUCCESS) {
            if (c == '\r' || c == '\n') {
                line[n] = 0;
                char command = !too_long && !strcmp(line, "FORMAT_AUDIO_STORAGE") ? 'F' :
                               !too_long && n == 1 ? line[0] : 0;
                if (command == 'h') printf("[AUDIO] e=register; x=cancel; r=record 5s; s=status.\n"
                    "[AUDIO] FORMAT_AUDIO_STORAGE erases the last 2 MiB of external QSPI flash (all audio registrations/recordings).\n");
                if (command && xQueueSend(commands, &command, 0) != pdPASS) printf("[AUDIO] Command queue full.\n");
                n = 0; too_long = false;
            } else if (n + 1 < sizeof(line)) line[n++] = (char)c;
            else too_long = true;
        } else vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void storage_task(void *arg)
{
    (void)arg;
    cy_rslt_t r = cy_serial_flash_qspi_init(smifMemConfigs[0],
        CYBSP_QSPI_D0, CYBSP_QSPI_D1, CYBSP_QSPI_D2, CYBSP_QSPI_D3,
        NC, NC, NC, NC, CYBSP_QSPI_SCK, CYBSP_QSPI_SS, 50000000u);
    if (r == CY_RSLT_SUCCESS) {
        size_t size = cy_serial_flash_qspi_get_size();
        flash_available = size >= AUDIO_STORE_BYTES && size <= UINT32_MAX;
        if (flash_available) {
            flash_base = (uint32_t)size - AUDIO_STORE_BYTES;
            for (unsigned i = 0; i < AUDIO_SLOT_COUNT; ++i) {
                size_t erase = cy_serial_flash_qspi_get_erase_size(flash_base + i * AUDIO_SLOT_SIZE);
                if (!erase || AUDIO_SLOT_SIZE % erase || (flash_base + i * AUDIO_SLOT_SIZE) % erase) flash_available = false;
            }
        }
    }
    if (flash_available) {
        audio_flash_t driver = {flash_read, flash_write, flash_erase};
        if (audio_store_open(&store, driver)) {
            bool loaded = audio_store_load_model(&store, &model);
            printf("[AUDIO] Storage ready; registered model %s.\n", loaded ? "loaded" : "not found");
        } else printf("[AUDIO] Storage uninitialized. Enter h for explicit format instructions.\n");
    } else printf("[AUDIO] QSPI storage unavailable (0x%08lx). No persistent recording possible.\n", (unsigned long)r);
    if (xTaskCreate(audio_task, "Audio", 4096, NULL, 4, NULL) != pdPASS ||
        xTaskCreate(console_task, "AudioConsole", 1024, NULL, 1, NULL) != pdPASS) {
        printf("[AUDIO] Task allocation failed. Reset required.\n"); vTaskDelete(NULL); return;
    }
    TickType_t retry = 0;
    unsigned next_slot = AUDIO_EVENT_FIRST_SLOT;
    bool quarantined[AUDIO_SLOT_COUNT] = {false};
    for (;;) {
        job_t job;
        if (xQueueReceive(jobs, &job, pdMS_TO_TICKS(1000)) == pdPASS) {
            if (job == JOB_FORMAT) {
                bool ok = audio_store_format(&store); formatting = false;
                if (ok) memset(quarantined, 0, sizeof(quarantined));
                printf("[AUDIO] Storage format %s.\n", ok ? "complete; enter e to register" : "FAILED");
            } else if (job == JOB_MODEL) {
                bool ok = audio_store_save_model(&store, &model_to_save); model_busy = false;
                printf("[SETUP] Model persistence %s.\n", ok ? "verified" : "FAILED; current model is RAM-only");
            } else {
                uint32_t id[4];
                mbedtls_entropy_context entropy;
                mbedtls_entropy_init(&entropy);
                int result = mbedtls_entropy_func(&entropy, (unsigned char *)id, sizeof(id));
                mbedtls_entropy_free(&entropy);
                bool ok = result == 0 && audio_store_enqueue(&store, pending_pcm, pending_samples, id, pending_score);
                clip_busy = false;
                printf("[AUDIO] Recording %s.\n", ok ? "saved to flash; awaiting server ACK" : "NOT SAVED (storage full/uninitialized/I/O/entropy error)");
            }
        }
        if (connected && audio_upload_configured() && (int32_t)(xTaskGetTickCount() - retry) >= 0) {
            int slot = -1;
            for (unsigned attempt = AUDIO_EVENT_FIRST_SLOT; attempt < AUDIO_SLOT_COUNT; ++attempt) {
                unsigned i = next_slot;
                next_slot = i + 1 == AUDIO_SLOT_COUNT ? AUDIO_EVENT_FIRST_SLOT : i + 1;
                if (store.ready && store.valid[i] && store.record[i].acknowledged && !quarantined[i]) { slot = (int)i; break; }
            }
            if (slot >= 0) {
                if (!audio_store_verify(&store, (unsigned)slot)) {
                    quarantined[slot] = true;
                    printf("[UPLOAD] Corrupt recording quarantined in slot %u; other recordings remain eligible.\n", (unsigned)slot);
                    continue;
                }
                bool ok = audio_upload(&store, (unsigned)slot);
                if (ok) ok = audio_store_ack(&store, (unsigned)slot);
                printf("[UPLOAD] %s.\n", ok ? "Server ACK saved; slot reusable" : "Unconfirmed; retaining recording for retry");
                retry = xTaskGetTickCount() + pdMS_TO_TICKS(ok ? 1000 : 30000);
            }
        }
    }
}

bool audio_app_start(void)
{
    frames = xQueueCreate(32, sizeof(frame_t));
    commands = xQueueCreate(4, sizeof(char));
    jobs = xQueueCreate(3, sizeof(job_t));
    return frames && commands && jobs && xTaskCreate(storage_task, "AudioStore", 4096, NULL, 2, NULL) == pdPASS;
}
