#include "audio_app.h"
#include "audio_link.h"
#include "chime_detector.h"
#include "audio_upload.h"
#include "tune.h"
#include "voice_capture.h"
#include "xlog.h"
#include <math.h>
#include <string.h>

#define LOOPBACK_FRAMES 150u /* 3 s */

_Static_assert(AUDIO_RATE == 16000u && AUDIO_FRAME == 320u, "PDM/DSP frame mismatch");

audio_jobs_t audio_jobs;
static audio_model_t model;
static audio_dsp_t dsp;
static audio_ring_t *ring_buffer;
static chime_detector_t detector;
static chime_enroll_t enroll;
static bool clips_enabled, detector_ready;
/* ENROLL: background, then the ring (chime_enroll_push). ANALYZE: the ring's
 * variants, CHIME_WORK_FRAMES per frame, from a copy in audio_jobs.pending_pcm. */
static enum { NORMAL, ENROLL, ANALYZE } mode;
static volatile uint32_t enroll_phase, enroll_reason; /* audio task writes, any task reads */
static unsigned warmup, reject_until_quiet;
static unsigned post, clip_frames, manual, loopback;
static float score;
static voice_capture_t voice_capture;
static bool voice_call_active;
static uint32_t voice_listen_sequence, voice_turn, voice_call_listen_baseline;

void audio_app_init(audio_ring_t *ring, int16_t *pending, bool record_clips)
{
    ring_buffer = ring;
    memset(ring_buffer, 0, sizeof(*ring_buffer));
    memset(&audio_jobs, 0, sizeof(audio_jobs));
    audio_jobs.pending_pcm = pending;
    clips_enabled = record_clips;
    audio_dsp_init(&dsp);
    voice_capture_init(&voice_capture);
    memset(&model, 0, sizeof(model));
    detector_ready = false;
    mode = NORMAL;
    enroll_phase = AUDIO_ENROLL_IDLE; enroll_reason = CHIME_REASON_NONE;
    warmup = 50u;
    reject_until_quiet = post = clip_frames = manual = loopback = 0u;
    voice_call_active = false;
    voice_listen_sequence = voice_turn = voice_call_listen_baseline = 0u;
    audio_link()->audio_status = 0u;
    audio_link()->last_score = -1.0f;
    audio_link_release();
}
audio_model_t *audio_app_model(void) { return &model; }
bool audio_app_model_valid(void) { return audio_model_valid(&model); }
float audio_app_threshold(void) { return model.threshold; }
float audio_app_gate(void) { return model.gate_rms; }
audio_enroll_status_t audio_app_enroll_status(void)
{
    audio_enroll_status_t status = {(audio_enroll_phase_t)enroll_phase, (chime_reason_t)enroll_reason};
    if (status.phase == AUDIO_ENROLL_SAVING && !audio_jobs.model_busy) status.phase = AUDIO_ENROLL_DONE;
    return status;
}
bool audio_app_enroll_start(void) { return audio_app_post_command('e'); }
bool audio_app_enroll_cancel(void) { return audio_app_post_command('x'); }
void audio_app_loopback_release(void)
{
    audio_link()->loopback_samples = 0u;
    audio_jobs.clip_busy = false;
}

static void publish_voice_end(void)
{
    volatile audio_link_t *link = audio_link();
    if (voice_capture.state != VOICE_CAPTURE_FINISHED ||
        link->voice_end_listen_seq == voice_listen_sequence) return;
    link->voice_end_seq = link->voice_write_seq;
    link->voice_end_turn = voice_turn;
    link->voice_end_reason = (uint32_t)voice_capture.end;
    link->voice_samples = voice_capture.emitted_frames * AUDIO_FRAME;
    audio_link_release();
    link->voice_end_listen_seq = voice_listen_sequence;
}
static bool publish_voice_frame(void *context, const int16_t pcm[AUDIO_FRAME])
{
    (void)context;
    volatile audio_link_t *link = audio_link();
    uint32_t write = link->voice_write_seq;
    uint32_t read = link->voice_read_seq;
    audio_link_acquire();
    if ((uint32_t)(write - read) >= AUDIO_LINK_RING_FRAMES) return false;
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        link->voice_pcm[write % AUDIO_LINK_RING_FRAMES][i] = pcm[i];
    audio_link_release();
    link->voice_write_seq = write + 1u;
    return true;
}
static void submit_clip(uint32_t wanted_samples, float clip_score)
{
    if (!clips_enabled) {
        xlog("[AUDIO] Recording disabled: no upload destination is configured.\n"); return;
    }
    if (audio_jobs.clip_busy || audio_jobs.formatting) {
        xlog("[AUDIO] Recording dropped: previous recording is still being saved.\n"); return;
    }
    audio_jobs.pending_samples = audio_ring_copy(ring_buffer, audio_jobs.pending_pcm, wanted_samples);
    audio_jobs.pending_score = clip_score;
    audio_jobs.clip_busy = true;
    audio_jobs.clip_saving = true;
}
/* Leaves registration; the active model is untouched. */
static void stop_enroll(audio_enroll_phase_t phase, chime_reason_t reason, const char *message)
{
    if (mode == NORMAL) return;
    if (mode == ANALYZE) audio_jobs.clip_busy = false; /* the copy of the ring is no longer read */
    if (message) xlog("%s", message);
    mode = NORMAL;
    enroll_reason = reason; enroll_phase = phase;
}
void audio_app_command(char command)
{
    volatile audio_link_t *link = audio_link();
    if (command == 'e' && !voice_call_active && !audio_jobs.model_busy && !audio_jobs.formatting &&
        !audio_jobs.clip_busy && audio_storage_ready()) {
        chime_enroll_begin(&enroll);
        mode = ENROLL; post = manual = 0;
        enroll_reason = CHIME_REASON_NONE; enroll_phase = AUDIO_ENROLL_NOISE;
        xlog("[SETUP] Keep quiet for 2 seconds. Measuring background noise.\n");
    } else if (command == 'x') {
        stop_enroll(AUDIO_ENROLL_CANCELLED, CHIME_REASON_NONE, NULL);
        post = manual = 0;
        xlog("[SETUP] Registration cancelled; active model is unchanged.\n");
    } else if (command == 'r' && !voice_call_active && !audio_jobs.clip_busy && !audio_jobs.formatting) {
        stop_enroll(AUDIO_ENROLL_CANCELLED, CHIME_REASON_NONE, "[SETUP] Manual recording; registration cancelled.\n");
        post = 0; manual = 250;
        xlog("[AUDIO] Manual recording started (5 seconds).\n");
    } else if (command == 'l') {
        if (voice_call_active || audio_jobs.clip_busy || audio_jobs.formatting || mode != NORMAL || manual || post || loopback) {
            link->loopback_failed = 1u;
            return;
        }
        loopback = LOOPBACK_FRAMES;
        xlog("[DIAG] loopback recording\n");
    } else if (command == 'F' && !voice_call_active && !audio_jobs.clip_busy && !audio_jobs.model_busy && !audio_jobs.formatting) {
        stop_enroll(AUDIO_ENROLL_CANCELLED, CHIME_REASON_NONE, "[SETUP] Storage format; registration cancelled.\n");
        audio_jobs.formatting = true; post = manual = 0;
        memset(&model, 0, sizeof(model));
        detector_ready = false;
    } else if (command == 's') {
        xlog("[AUDIO] model=%s threshold=%.3f margin=%lu%% gate=%.0f rms=%.0f errors=%lu detected=%lu upload=%s\n",
            audio_model_valid(&model) ? "registered" : "none", (double)model.threshold,
            (unsigned long)tune_chime_margin(), (double)model.gate_rms, (double)link->last_rms,
            (unsigned long)link->capture_errors, (unsigned long)link->detected_count,
            audio_upload_configured() ? "configured" : "disabled");
    } else if (command != 'h') xlog("[AUDIO] Command unavailable; check storage initialization/busy state.\n");
}
void audio_app_service(void)
{
    volatile audio_link_t *link = audio_link();
    audio_link_acquire();
    bool call_active = link->voice_call_active != 0u;
    /* A detected chime's short tail finishes before the call takes the mic. */
    if (call_active != voice_call_active && !(call_active && post)) {
        if (call_active) stop_enroll(AUDIO_ENROLL_FAILED, CHIME_REASON_NONE, "[SETUP] Call started; registration cancelled.\n");
        if (detector_ready) chime_detector_reset(&detector);
        manual = 0; loopback = 0;
        ring_buffer->used = 0u;
        voice_capture_pause(&voice_capture);
        voice_call_active = call_active;
        if (call_active) voice_call_listen_baseline = link->voice_listen_seq;
        audio_link_release();
        link->voice_call_ack = call_active ? 1u : 0u;
    }
    uint32_t listen_sequence = link->voice_listen_seq;
    audio_link_acquire();
    bool record_enabled = link->voice_record_enabled != 0u;
    if (voice_call_active && !record_enabled) {
        voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_CANCELLED);
        publish_voice_end();
    }
    if (voice_call_active && record_enabled && listen_sequence != 0u &&
        listen_sequence != voice_call_listen_baseline &&
        listen_sequence != link->voice_listen_ack &&
        (voice_capture.state == VOICE_CAPTURE_IDLE || voice_capture.state == VOICE_CAPTURE_FINISHED) &&
        link->voice_read_seq == link->voice_write_seq) {
        /* Old PCM must have been consumed/discarded before another generation.
         * Clearing pre-roll here also excludes servo/speaker noise. */
        voice_listen_sequence = listen_sequence;
        voice_turn = link->voice_listen_turn;
        voice_capture_listen(&voice_capture, link->voice_rms_gate);
        link->voice_samples = 0u;
        audio_link_release();
        link->voice_listen_ack = listen_sequence;
    }
}
void audio_app_no_frame(void)
{
    volatile audio_link_t *link = audio_link();
    post = manual = 0; ring_buffer->used = 0u;
    if (detector_ready) chime_detector_reset(&detector);
    if (loopback) { loopback = 0; link->loopback_failed = 2u; }
    if (voice_call_active) {
        voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_GAP);
        publish_voice_end();
    }
    if (link->audio_status != 2u) /* once per failure: the read retries every second */
        xlog("[AUDIO] No microphone frames received; detection is unavailable.\n");
    link->audio_status = 2u;
}
static void enroll_frame(const int16_t pcm[AUDIO_FRAME])
{
    if (mode == ANALYZE) {
        chime_enroll_event_t event = chime_enroll_work(&enroll, &dsp, CHIME_WORK_FRAMES);
        if (event == CHIME_ENROLL_EV_DONE) {
            audio_jobs.clip_busy = false;
            model = enroll.model;
            chime_detector_init(&detector, &model);
            detector_ready = true;
            audio_jobs.model_to_save = model;
            audio_link_release();
            audio_jobs.model_busy = true;
            mode = NORMAL;
            enroll_reason = CHIME_REASON_NONE; enroll_phase = AUDIO_ENROLL_SAVING;
            xlog("[SETUP] Registered (%.1f s, threshold=%.3f). Saving registered features.\n",
                 (double)model.length * 0.02, (double)model.threshold);
        } else if (event == CHIME_ENROLL_EV_FAILED) {
            const char *message = enroll.reason == CHIME_REASON_NOISE_MATCH
                ? "[SETUP] Background sounds like the chime; retry in a quieter setting.\n"
                : "[SETUP] Recording did not hold up; enter e to start again.\n";
            stop_enroll(AUDIO_ENROLL_FAILED, enroll.reason, message);
        }
        return;
    }
    switch (chime_enroll_push(&enroll, &dsp, pcm)) {
    case CHIME_ENROLL_EV_NOISE_DONE:
        enroll_phase = AUDIO_ENROLL_LISTEN;
        xlog("[SETUP] Ring the intercom once. Gate=%.0f.\n", (double)enroll.gate);
        break;
    case CHIME_ENROLL_EV_RETRY:
        enroll_reason = enroll.reason;
        xlog("[SETUP] Sound too short or clipped; ring once again.\n");
        break;
    case CHIME_ENROLL_EV_NEED_PCM: {
        /* Registration started with clip_busy clear and nothing else records
         * while it runs, so the pending buffer is free for the ring's copy. */
        audio_jobs.clip_busy = true;
        uint32_t samples = audio_ring_copy(ring_buffer, audio_jobs.pending_pcm, chime_enroll_pcm_samples(&enroll));
        if (chime_enroll_set_pcm(&enroll, audio_jobs.pending_pcm, samples) == CHIME_ENROLL_EV_FAILED) {
            mode = ANALYZE; /* so that stop_enroll releases the buffer */
            stop_enroll(AUDIO_ENROLL_FAILED, enroll.reason, "[SETUP] Recording did not hold up; enter e to start again.\n");
            break;
        }
        mode = ANALYZE; enroll_phase = AUDIO_ENROLL_ANALYZE;
        xlog("[SETUP] Sound recorded (%.1f s). Checking it.\n", (double)enroll.model.length * 0.02);
        break;
    }
    case CHIME_ENROLL_EV_FAILED:
        stop_enroll(AUDIO_ENROLL_FAILED, enroll.reason, "[SETUP] Too noisy; retry in a quieter setting.\n");
        break;
    default: break;
    }
}
static void detect_frame(const int16_t pcm[AUDIO_FRAME])
{
    volatile audio_link_t *link = audio_link();
    /* The recording tail runs alongside detection, which is in its refractory time. */
    if (post && --post == 0) submit_clip(clip_frames * AUDIO_FRAME, score);
    if (!detector_ready) {
        if (!audio_model_valid(&model)) return;
        chime_detector_init(&detector, &model); /* the model loaded from flash */
        detector_ready = true;
    }
    if (reject_until_quiet) {
        /* After a capture gap: a sound cut in two is never matched. */
        if (link->last_rms >= chime_detector_gate(&detector)) reject_until_quiet = 50;
        else if (--reject_until_quiet == 0) chime_detector_reset(&detector);
        return;
    }
    chime_result_t result;
    float limit = model.threshold * (float)tune_chime_margin() / 100.0f;
    chime_event_t event = chime_detector_push(&detector, &dsp, pcm, limit, &result);
    if (event == CHIME_SOUND_END) link->last_score = result.score;
    if (event != CHIME_DETECTED) return;
    score = result.score;
    link->last_score = score;
    ++link->detected_count;
    xlog("[DETECTED] Doorbell, distance=%.3f.\n", (double)score);
    /* Publish first: a recording tail must never delay the call. */
    audio_link_release();
    link->event_seq = link->event_seq + 1u;
    if (clips_enabled && !post) {
        /* Before the match, the match itself, and after it. */
        clip_frames = AUDIO_PRE_FRAMES + result.frames + AUDIO_POST_FRAMES;
        if (clip_frames > AUDIO_CLIP_SAMPLES / AUDIO_FRAME) clip_frames = AUDIO_CLIP_SAMPLES / AUDIO_FRAME;
        post = AUDIO_POST_FRAMES;
    }
}
void audio_app_frame(const int16_t pcm[AUDIO_FRAME], bool gap)
{
    volatile audio_link_t *link = audio_link();
    ++link->heartbeat;
    link->audio_status = 1u;
    int32_t minimum = 32767, maximum = -32768;
    float energy = 0.0f;
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) {
        int32_t value = pcm[i];
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
        energy += (float)value * (float)value;
    }
    link->pcm_min = minimum; link->pcm_max = maximum;
    link->last_rms = sqrtf(energy / (float)AUDIO_FRAME);
    if (gap) {
        ++link->capture_errors;
        post = manual = 0; ring_buffer->used = 0u; reject_until_quiet = 50;
        if (detector_ready) chime_detector_reset(&detector);
        if (loopback) { loopback = 0; link->loopback_failed = 2u; }
        stop_enroll(AUDIO_ENROLL_FAILED, CHIME_REASON_NONE, "[SETUP] Capture gap; registration cancelled.\n");
        if (voice_call_active) {
            voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_GAP);
            publish_voice_end();
        } else xlog("[AUDIO] Capture gap; incomplete candidate/recording discarded.\n");
    }
    if (warmup) { --warmup; return; }
    if (voice_call_active) {
        /* PDM keeps running so DMA stays healthy; samples are discarded while
         * the AI is speaking, never retained in either pre-roll. */
        voice_capture_feed(&voice_capture, pcm, publish_voice_frame, NULL);
        link->voice_samples = voice_capture.emitted_frames * AUDIO_FRAME;
        publish_voice_end();
        return;
    }
    audio_ring_push(ring_buffer, pcm, AUDIO_FRAME);
    if (audio_jobs.formatting) return;
    if (loopback) {
        if (--loopback == 0u) {
            audio_jobs.pending_samples = audio_ring_copy(ring_buffer, audio_jobs.pending_pcm, LOOPBACK_FRAMES * AUDIO_FRAME);
            audio_jobs.clip_busy = true;
            audio_link_release();
            link->loopback_samples = audio_jobs.pending_samples;
        }
        return;
    }
    if (manual) { if (--manual == 0) submit_clip(5u * AUDIO_RATE, -1.0f); return; }
    if (mode != NORMAL) { enroll_frame(pcm); return; }
    detect_frame(pcm);
}
