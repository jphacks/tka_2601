#include "audio_app.h"
#include "audio_link.h"
#include "audio_upload.h"
#include "tune.h"
#include "voice_capture.h"
#include "xlog.h"
#include <math.h>
#include <string.h>

#define LOOPBACK_FRAMES 150u /* 3 s */

_Static_assert(AUDIO_RATE == 16000u && AUDIO_FRAME == 320u, "PDM/DSP frame mismatch");

audio_jobs_t audio_jobs;
static audio_model_t model, enrolling;
static audio_dsp_t dsp;
static audio_ring_t *ring_buffer;
static audio_pattern_t candidate;
static bool clips_enabled;
static enum { NORMAL, NOISE, ENROLL, VERIFY } mode;
static unsigned warmup, noise_frames, quiet, clipped, reject_until_quiet;
static unsigned post, clip_frames, manual, loopback;
static float noise_sum, score;
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
    memset(&model, 0, sizeof(model)); memset(&candidate, 0, sizeof(candidate));
    mode = NORMAL;
    warmup = 50u;
    noise_frames = quiet = clipped = reject_until_quiet = post = clip_frames = manual = loopback = 0u;
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
void audio_app_command(char command)
{
    volatile audio_link_t *link = audio_link();
    if (command == 'e' && !voice_call_active && !audio_jobs.model_busy && !audio_jobs.formatting && audio_storage_ready()) {
        memset(&enrolling, 0, sizeof(enrolling));
        mode = NOISE; noise_frames = 0; noise_sum = 0; candidate.length = 0;
        post = manual = 0;
        xlog("[SETUP] Keep quiet for 5 seconds. Measuring background noise.\n");
    } else if (command == 'x') {
        mode = NORMAL; candidate.length = 0; post = manual = 0;
        xlog("[SETUP] Registration cancelled; active model is unchanged.\n");
    } else if (command == 'r' && !voice_call_active && !audio_jobs.clip_busy && !audio_jobs.formatting) {
        mode = NORMAL; candidate.length = 0; post = 0; manual = 250;
        xlog("[AUDIO] Manual recording started (5 seconds).\n");
    } else if (command == 'l') {
        if (voice_call_active || audio_jobs.clip_busy || audio_jobs.formatting || mode != NORMAL || manual || post || loopback) {
            link->loopback_failed = 1u;
            return;
        }
        loopback = LOOPBACK_FRAMES;
        xlog("[DIAG] loopback recording\n");
    } else if (command == 'F' && !voice_call_active && !audio_jobs.clip_busy && !audio_jobs.model_busy && !audio_jobs.formatting) {
        audio_jobs.formatting = true; mode = NORMAL; candidate.length = 0; post = manual = 0;
        memset(&model, 0, sizeof(model));
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
        if (call_active && mode != NORMAL) {
            mode = NORMAL;
            xlog("[SETUP] Call started; registration cancelled.\n");
        }
        candidate.length = 0; manual = 0; loopback = 0;
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
    candidate.length = 0; post = manual = 0; ring_buffer->used = 0u;
    if (loopback) { loopback = 0; link->loopback_failed = 1u; }
    if (voice_call_active) {
        voice_capture_abort(&voice_capture, VOICE_CAPTURE_END_GAP);
        publish_voice_end();
    }
    link->audio_status = 2u;
    xlog("[AUDIO] No microphone frames received; detection is unavailable. Reset to retry.\n");
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
        candidate.length = 0; post = manual = 0; ring_buffer->used = 0u; reject_until_quiet = 50;
        if (loopback) { loopback = 0; link->loopback_failed = 1u; }
        if (mode != NORMAL) { mode = NORMAL; xlog("[SETUP] Capture gap; registration cancelled.\n"); }
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
    if (post) {
        if (--post == 0) {
            submit_clip(clip_frames * AUDIO_FRAME, score);
            reject_until_quiet = 50;
        }
        return;
    }
    audio_feature_t feature;
    float rms = audio_feature(&dsp, pcm, &feature);
    if (mode == NOISE) {
        noise_sum += rms;
        if (++noise_frames == 250) {
            enrolling.gate_rms = fmaxf(80.0f, noise_sum / noise_frames * 4.0f);
            if (enrolling.gate_rms > 16000) { mode = NORMAL; xlog("[SETUP] Too noisy; retry in a quieter setting.\n"); return; }
            mode = ENROLL; quiet = 0; reject_until_quiet = 0;
            xlog("[SETUP] Ring the intercom once (1/3). Gate=%.0f.\n", (double)enrolling.gate_rms);
        }
        return;
    }
    float gate = mode == NORMAL ? model.gate_rms : enrolling.gate_rms;
    if (mode == NORMAL && !audio_model_valid(&model)) return;
    bool loud = rms >= gate;
    if (reject_until_quiet) {
        if (loud) reject_until_quiet = 50;
        else --reject_until_quiet;
        return;
    }
    if (!candidate.length && !loud) return;
    if (!candidate.length) { quiet = 0; clipped = 0; }
    for (unsigned i = 0; i < AUDIO_FRAME; ++i)
        if (pcm[i] >= 32700 || pcm[i] <= -32700) ++clipped;
    if (!loud) memset(&feature, 0, sizeof(feature));
    if (candidate.length == AUDIO_MAX_FRAMES + AUDIO_END_FRAMES ||
        (loud && candidate.length >= AUDIO_MAX_FRAMES)) {
        candidate.length = 0; reject_until_quiet = 50;
        xlog("[AUDIO] Candidate longer than 4 seconds; ignored.\n"); return;
    }
    candidate.frame[candidate.length++] = feature;
    quiet = loud ? 0 : quiet + 1;
    if (quiet < AUDIO_END_FRAMES) return;
    candidate.length -= quiet;
    if (candidate.length < 10 || clipped > candidate.length * AUDIO_FRAME / 100) {
        candidate.length = 0; xlog("[AUDIO] Candidate too short or clipped; ignored.\n"); return;
    }
    if (mode == ENROLL) {
        enrolling.pattern[enrolling.count++] = candidate;
        if (enrolling.count == AUDIO_TEMPLATES) {
            if (audio_calibrate(&enrolling)) {
                mode = VERIFY; xlog("[SETUP] Three recordings agree. Ring once more to verify.\n");
            } else {
                mode = NORMAL; xlog("[SETUP] Recordings differ too much. Enter e to start again.\n");
            }
        } else xlog("[SETUP] Recorded. Ring once again (%lu/3).\n", (unsigned long)enrolling.count + 1);
    } else if (mode == VERIFY) {
        float distance = audio_match(&enrolling, &candidate);
        if (distance <= enrolling.threshold && !audio_jobs.model_busy) {
            model = enrolling; audio_jobs.model_to_save = enrolling;
            audio_link_release();
            audio_jobs.model_busy = true;
            mode = NORMAL; xlog("[SETUP] Verification passed. Saving registered features.\n");
        } else xlog("[SETUP] Verification did not match. Retry, or e to register again.\n");
    } else {
        score = audio_match(&model, &candidate);
        link->last_score = score;
        if (score <= model.threshold * (float)tune_chime_margin() / 100.0f) {
            ++link->detected_count;
            xlog("[DETECTED] Doorbell, distance=%.3f.\n", (double)score);
            /* Publish first: a recording tail must never delay the call. */
            audio_link_release();
            link->event_seq = link->event_seq + 1u;
            if (clips_enabled) {
                clip_frames = AUDIO_PRE_FRAMES + candidate.length + AUDIO_POST_FRAMES;
                post = AUDIO_POST_FRAMES - quiet;
            } else reject_until_quiet = 50;
        }
    }
    candidate.length = 0;
}
