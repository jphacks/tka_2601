/* chime_detector.c: registration from one ring and streaming detection. */
#include "chime_detector.h"
#include "chime_synth.h"
#include <assert.h>
#include <float.h>
#include <stdio.h>
#include <string.h>

#define SECONDS 20u
static float buffer[SECONDS * AUDIO_RATE];
static int16_t pcm[SECONDS * AUDIO_RATE];
static audio_dsp_t dsp;
static chime_enroll_t enroll;
static chime_detector_t detector;
static audio_model_t model;

static size_t frames_of(float seconds) { return (size_t)(seconds * AUDIO_RATE) / AUDIO_FRAME * AUDIO_FRAME; }

/* buffer <- room noise; returns samples. */
static size_t start(float seconds, syn_rng_t *r)
{
    memset(buffer, 0, sizeof(buffer));
    size_t n = frames_of(seconds);
    syn_add_pink(buffer, n, SYN_ROOM, r);
    return n;
}
static void add_chime(const syn_chime_t *c, float at, float level)
{
    static float event[SECONDS * AUDIO_RATE];
    memset(event, 0, sizeof(event));
    syn_render(c, event, SECONDS * AUDIO_RATE, 0);
    size_t length = (size_t)(c->duration * AUDIO_RATE);
    syn_scale(event, length, level);
    size_t first = (size_t)(at * AUDIO_RATE);
    for (size_t i = 0; i < length && first + i < SECONDS * AUDIO_RATE; ++i) buffer[first + i] += event[i];
}
static chime_enroll_event_t register_buffer(size_t n)
{
    syn_to_pcm(buffer, pcm, n);
    return chime_enroll_from_pcm(&enroll, &dsp, pcm, (uint32_t)n);
}
static void register_chime(const syn_chime_t *c)
{
    syn_rng_t r = {7};
    size_t n = start(2.5f + c->duration + 1.5f, &r);
    add_chime(c, 2.5f, SYN_LEVEL);
    assert(register_buffer(n) == CHIME_ENROLL_EV_DONE);
    model = enroll.model;
    assert(audio_model_valid(&model));
    assert(model.threshold >= CHIME_THRESHOLD_LOW && model.threshold <= CHIME_THRESHOLD_HIGH);
}
/* Detections in buffer[0, n); frame index (end of frame) of each in at[]. */
static unsigned detect(size_t n, unsigned at[8], float *best)
{
    syn_to_pcm(buffer, pcm, n);
    chime_detector_init(&detector, &model);
    unsigned count = 0;
    *best = FLT_MAX;
    for (size_t s = 0; s + AUDIO_FRAME <= n; s += AUDIO_FRAME) {
        chime_result_t r;
        chime_event_t e = chime_detector_push(&detector, &dsp, pcm + s, model.threshold, &r);
        if (r.frames && r.score < *best) *best = r.score;
        if (e == CHIME_DETECTED) {
            assert(r.score <= model.threshold && r.frames * 4 >= model.length * 3 && r.frames * 3 <= model.length * 4);
            if (count < 8) at[count] = (unsigned)(s / AUDIO_FRAME + 1);
            ++count;
        }
    }
    return count;
}

static void test_registration_reasons(const syn_chime_t *home)
{
    syn_rng_t r = {11};
    /* Background over the 16000 gate limit: too noisy. */
    size_t n = start(3.0f, &r);
    syn_add_white(buffer, n, 5000.0f, &r);
    assert(register_buffer(n) == CHIME_ENROLL_EV_FAILED && enroll.reason == CHIME_REASON_NOISY);
    /* A click is too short: still listening; the chime that follows registers. */
    n = start(2.5f + 1.0f + home->duration + 1.5f, &r);
    for (size_t i = 0; i < 1600; ++i) buffer[(size_t)(2.5f * AUDIO_RATE) + i] += 3000.0f * syn_gauss(&r);
    add_chime(home, 3.5f, SYN_LEVEL);
    syn_to_pcm(buffer, pcm, n);
    chime_enroll_begin(&enroll);
    bool retried = false;
    chime_enroll_event_t ev = CHIME_ENROLL_EV_NONE;
    for (size_t s = 0; s + AUDIO_FRAME <= n && ev != CHIME_ENROLL_EV_NEED_PCM; s += AUDIO_FRAME) {
        ev = chime_enroll_push(&enroll, &dsp, pcm + s);
        if (ev == CHIME_ENROLL_EV_RETRY) { assert(enroll.reason == CHIME_REASON_SHORT); retried = true; }
    }
    assert(retried && ev == CHIME_ENROLL_EV_NEED_PCM);
    assert(register_buffer(n) == CHIME_ENROLL_EV_DONE);
    /* Clipped: the ring is asked for again, and no model comes out. */
    n = start(2.5f + home->duration + 1.0f, &r);
    add_chime(home, 2.5f, 60000.0f);
    syn_to_pcm(buffer, pcm, n);
    chime_enroll_begin(&enroll);
    ev = CHIME_ENROLL_EV_NONE;
    for (size_t s = 0; s + AUDIO_FRAME <= n && ev != CHIME_ENROLL_EV_RETRY; s += AUDIO_FRAME)
        ev = chime_enroll_push(&enroll, &dsp, pcm + s);
    assert(ev == CHIME_ENROLL_EV_RETRY && enroll.reason == CHIME_REASON_CLIPPED && enroll.phase == CHIME_ENROLL_LISTEN);
    /* No recording: the PCM must cover the sound. */
    n = start(2.5f + home->duration + 1.0f, &r);
    add_chime(home, 2.5f, SYN_LEVEL);
    syn_to_pcm(buffer, pcm, n);
    chime_enroll_begin(&enroll);
    ev = CHIME_ENROLL_EV_NONE;
    for (size_t s = 0; s + AUDIO_FRAME <= n && ev != CHIME_ENROLL_EV_NEED_PCM; s += AUDIO_FRAME)
        ev = chime_enroll_push(&enroll, &dsp, pcm + s);
    assert(ev == CHIME_ENROLL_EV_NEED_PCM);
    assert(chime_enroll_set_pcm(&enroll, pcm, AUDIO_FRAME) == CHIME_ENROLL_EV_FAILED && enroll.reason == CHIME_REASON_NO_PCM);
    /* Over 4 s of sound: the first 3 s become the template, without waiting for the end. */
    syn_chime_t melody = *home;
    n = start(2.5f + 6.0f + 1.0f, &r);
    for (unsigned k = 0; k < 6; ++k) add_chime(&melody, 2.5f + 0.9f * (float)k, SYN_LEVEL);
    assert(register_buffer(n) == CHIME_ENROLL_EV_DONE);
    assert(enroll.model.length == AUDIO_TEMPLATE_FRAMES);
    assert(enroll.captured == CHIME_LONG_FRAMES);
    /* The background already plays the chime: not registered. A short two-note
     * blip stands out of a quiet background, so the gate (4x its mean) lets it
     * through both in the background and in the ring. */
    syn_chime_t blip = *home;
    blip.onset[1] = blip.onset[0] + 0.16f; blip.notes = 2; blip.duration = 0.4f;
    n = start(2.5f + 1.5f, &r);
    for (size_t i = 0; i < n; ++i) buffer[i] *= 0.1f;
    add_chime(&blip, 0.8f, 4000.0f);
    add_chime(&blip, 2.5f, 4000.0f);
    chime_enroll_event_t noise_case = register_buffer(n);
    printf("background playing the chime: %s (noise score %.3f, threshold %.3f)\n",
           noise_case == CHIME_ENROLL_EV_DONE ? "registered" : chime_reason_text(enroll.reason),
           (double)enroll.noise_score, (double)enroll.model.threshold);
    assert(noise_case == CHIME_ENROLL_EV_FAILED && enroll.reason == CHIME_REASON_NOISE_MATCH);
}

static void test_detection(const syn_chime_t *home, const syn_chime_t *other)
{
    register_chime(home);
    unsigned at[8]; float best;
    syn_rng_t r = {21};
    /* One ring, judged at the template's end while the tail is still sounding. */
    size_t n = start(1.0f + home->duration + 2.0f, &r);
    add_chime(home, 1.0f, SYN_LEVEL * 0.3f);
    assert(detect(n, at, &best) == 1);
    unsigned onset = 50, end_of_sound = onset + (unsigned)(home->duration * 50.0f);
    /* The end may be matched up to 3/4 of the template's length. */
    printf("one ring: detected %.2f s after the onset (template %.2f s, sound %.2f s)\n",
           (at[0] - onset) * 0.02, model.length * 0.02, home->duration);
    assert(at[0] <= onset + model.length * 4 / 3 + 2);
    assert(at[0] < end_of_sound + CHIME_END_FRAMES); /* never waits for 0.5 s of quiet */
    /* Ringing on and on (four rings, 1.2 s apart): one detection, during the ringing. */
    n = start(1.0f + 3.6f + home->duration + 1.0f, &r);
    for (unsigned k = 0; k < 4; ++k) add_chime(home, 1.0f + 1.2f * (float)k, SYN_LEVEL);
    unsigned count = detect(n, at, &best);
    printf("continuous ringing: %u detection(s), first at %.2f s\n", count, (at[0] - onset) * 0.02);
    assert(count >= 1 && at[0] < onset + (unsigned)((3.6f + home->duration) * 50.0f));
    /* Refractory: a second ring 2 s later is the same visit; 4 s later is a new one. */
    n = start(1.0f + 2.0f + home->duration + 1.0f, &r);
    add_chime(home, 1.0f, SYN_LEVEL); add_chime(home, 3.0f, SYN_LEVEL);
    assert(detect(n, at, &best) == 1);
    n = start(1.0f + 4.5f + home->duration + 1.0f, &r);
    add_chime(home, 1.0f, SYN_LEVEL); add_chime(home, 5.5f, SYN_LEVEL);
    assert(detect(n, at, &best) == 2 && at[1] - at[0] >= CHIME_REFRACTORY_FRAMES);
    /* Another chime, the same notes swapped, and speech are not the chime. */
    n = start(1.0f + other->duration + 1.0f, &r);
    add_chime(other, 1.0f, SYN_LEVEL);
    assert(detect(n, at, &best) == 0);
    printf("other chime: best %.3f vs threshold %.3f\n", (double)best, (double)model.threshold);
    syn_chime_t swapped = *home; syn_swap(&swapped);
    n = start(1.0f + swapped.duration + 1.0f, &r);
    add_chime(&swapped, 1.0f, SYN_LEVEL);
    assert(detect(n, at, &best) == 0);
    printf("swapped notes: best %.3f vs threshold %.3f\n", (double)best, (double)model.threshold);
    static float speech[5 * AUDIO_RATE];
    n = start(5.0f, &r);
    syn_speech(speech, n, AUDIO_RATE / 2, 3.0f, &r);
    syn_scale(speech, n, SYN_LEVEL);
    for (size_t i = 0; i < n; ++i) buffer[i] += speech[i];
    assert(detect(n, at, &best) == 0);
    /* A sound that ends without a match reports its best score once. */
    syn_to_pcm(buffer, pcm, n);
    chime_detector_init(&detector, &model);
    unsigned ends = 0;
    for (size_t s = 0; s + AUDIO_FRAME <= n; s += AUDIO_FRAME) {
        chime_result_t res;
        if (chime_detector_push(&detector, &dsp, pcm + s, model.threshold, &res) == CHIME_SOUND_END) {
            ++ends; assert(res.score > model.threshold && res.score < FLT_MAX);
        }
    }
    assert(ends >= 1);
    /* A reset drops a half-matched ring: the second half alone does not match. */
    n = start(1.0f + home->duration + 1.0f, &r);
    add_chime(home, 1.0f, SYN_LEVEL);
    syn_to_pcm(buffer, pcm, n);
    chime_detector_init(&detector, &model);
    unsigned hits = 0;
    size_t half = frames_of(1.0f + home->duration * 0.5f);
    for (size_t s = 0; s + AUDIO_FRAME <= n; s += AUDIO_FRAME) {
        if (s == half) chime_detector_reset(&detector);
        hits += chime_detector_push(&detector, &dsp, pcm + s, model.threshold, NULL) == CHIME_DETECTED;
    }
    assert(hits == 0);
    /* A negative limit never detects. */
    n = start(1.0f + home->duration + 1.0f, &r);
    add_chime(home, 1.0f, SYN_LEVEL);
    syn_to_pcm(buffer, pcm, n);
    chime_detector_init(&detector, &model);
    for (size_t s = 0; s + AUDIO_FRAME <= n; s += AUDIO_FRAME)
        assert(chime_detector_push(&detector, &dsp, pcm + s, -1.0f, NULL) != CHIME_DETECTED);
}

static void test_model_checks(void)
{
    audio_model_t m = model;
    assert(audio_model_valid(&m));
    m.version = 1; assert(!audio_model_valid(&m));
    m = model; m.length = AUDIO_TEMPLATE_MIN_FRAMES - 1; assert(!audio_model_valid(&m));
    m = model; m.length = AUDIO_TEMPLATE_FRAMES + 1; assert(!audio_model_valid(&m));
    m = model; m.threshold = NAN; assert(!audio_model_valid(&m));
    m = model; m.threshold = AUDIO_THRESHOLD_MAX * 2; assert(!audio_model_valid(&m));
    m = model; m.gate_rms = INFINITY; assert(!audio_model_valid(&m));
    m = model; m.frame[0].loud = 0; memset(&m.frame[0], 0, sizeof(m.frame[0])); assert(!audio_model_valid(&m));
    m = model; m.frame[1].loud = 2; assert(!audio_model_valid(&m));
    m = model; m.frame[1].cent = -5; assert(!audio_model_valid(&m));
    m = model; m.frame[1].loud = 0; m.frame[1].onset = 1; assert(!audio_model_valid(&m));
}

int main(void)
{
    audio_dsp_init(&dsp);
    /* audio_pitch: a pure 1 kHz tone is tonal, at 1200 log2(1000/55) cents. */
    int16_t tone[AUDIO_FRAME];
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) tone[i] = (int16_t)(8000.0f * sinf(2 * SYN_PI * 1000.0f * (float)i / AUDIO_RATE));
    audio_feature_t mel; int16_t cent;
    audio_feature(&dsp, tone, &mel);
    float share = audio_pitch(&dsp, &cent);
    assert(share > 0.5f && abs(cent - 5021) < 15);
    syn_rng_t r = {3};
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) tone[i] = (int16_t)(3000.0f * syn_gauss(&r));
    audio_feature(&dsp, tone, &mel);
    assert(audio_pitch(&dsp, &cent) < CHIME_TONAL_SHARE);

    syn_rng_t hr = {1002};
    syn_chime_t home, other;
    syn_chime(&home, &hr);
    do syn_chime(&other, &hr); while (syn_contains_tune(&other, &home));
    test_registration_reasons(&home);
    test_detection(&home, &other);
    test_model_checks();
    puts("PASS: chime registration reasons, ringing detection, refractory, other/swapped/speech rejected, model checks");
    return 0;
}
