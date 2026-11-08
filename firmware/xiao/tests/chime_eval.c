/* Synthetic evaluation of the chime detectors (bash run.sh eval).
 *
 * Seeded chimes for HOUSEHOLDS homes. Each home registers its chime once with
 * the new detector (chime_detector.c: one ring) and with the old one
 * (tests/chime_eval_old.c: 5 s of background, three rings, one verification),
 * then both hear the same clips: the chime through different paths and noises
 * (positives) and other sounds (negatives). Clips are 1.5 s of background (10 s
 * when the condition adds steady noise), the sound, and 1.5 s of background,
 * over the quiet-room noise SYN_ROOM.
 *
 * Everything here is synthesized. It ranks the two detectors and catches
 * regressions; it does not measure a real intercom, microphone or room.
 *
 *   chime_eval            the table
 *   chime_eval -v         also each home's threshold, misses and false detections
 *   chime_eval --seed N   other homes (held-out check; the constants were tuned on N=1000)
 *   chime_eval --check    exit 1 when the targets are not met (CI, on the tuning seed)
 *   chime_eval --wav DIR  writes DIR/enroll.wav and DIR/target.wav for the WAV tool
 */
#include "chime_detector.h"
#include "chime_eval_old.h"
#include "chime_synth.h"
#include <float.h>
#include <stdio.h>
#include <string.h>

#define HOUSEHOLDS 20u
#define TRIALS 5u
#define MAX_SECONDS 20u
#define MAX_SAMPLES (MAX_SECONDS * AUDIO_RATE)

typedef enum { P_CLEAN, P_GAIN, P_TILT_UP, P_TILT_DOWN, P_REVERB, P_PINK, P_BABBLE, P_REPEAT,
               N_OTHER, N_SWAP, N_VOWEL, N_MUSIC, N_KNOCK, N_WHITE } kind_t;
typedef struct { const char *name; kind_t kind; float db, snr; } condition_t;
static const condition_t conditions[] = {
    {"静かな部屋（0 dB）", P_CLEAN, 0, 0},
    {"音量 -20 dB", P_GAIN, -20, 0},
    {"音量 -10 dB", P_GAIN, -10, 0},
    {"音量 +6 dB", P_GAIN, 6, 0},
    {"EQ 高域強調", P_TILT_UP, 0, 0},
    {"EQ 高域減衰", P_TILT_DOWN, 0, 0},
    {"残響 RT60 0.5 s", P_REVERB, 0, 0},
    {"ピンク雑音 SN 30 dB", P_PINK, 0, 30},
    {"ピンク雑音 SN 20 dB", P_PINK, 0, 20},
    {"ピンク雑音 SN 10 dB", P_PINK, 0, 10},
    {"ピンク雑音 SN 5 dB", P_PINK, 0, 5},
    {"話し声雑音 SN 20 dB", P_BABBLE, 0, 20},
    {"話し声雑音 SN 10 dB", P_BABBLE, 0, 10},
    {"ピンポンの繰り返し（2回）", P_REPEAT, 0, 0},
    {"別のチャイム", N_OTHER, 0, 0},
    {"音の順序を入れ替え", N_SWAP, 0, 0},
    {"母音の合成音声", N_VOWEL, 0, 0},
    {"音楽（倍音つき旋律）", N_MUSIC, 0, 0},
    {"ノック", N_KNOCK, 0, 0},
    {"白色雑音", N_WHITE, 0, 0},
};
#define CONDITIONS (sizeof(conditions) / sizeof(conditions[0]))

typedef struct {
    unsigned clips, new_hits, old_hits, new_extra, old_extra, new_events, old_events;
    double new_latency, old_latency; unsigned new_latency_n, old_latency_n;
    float new_closest; /* lowest score / threshold among negatives */
} tally_t;

static float buffer[MAX_SAMPLES];
static int16_t pcm[MAX_SAMPLES];
static audio_dsp_t dsp;
static chime_enroll_t enroll;
static old_detector_t old_home, old_run;
static chime_detector_t detector;
static bool verbose;

static bool positive(kind_t k) { return k <= P_REPEAT; }

/* Background for the whole clip; returns nothing, adds into buffer. */
static size_t render(kind_t kind, const condition_t *c, const syn_chime_t *home, syn_rng_t *r, size_t *onset)
{
    /* Steady noise is on long before the chime, so the noise floor has
     * followed it (it rises only slowly, and not under loud frames). */
    const bool noisy = kind == P_PINK || kind == P_BABBLE;
    const float lead = noisy ? 10.0f : 1.5f, tail = 1.5f;
    memset(buffer, 0, sizeof(buffer));
    *onset = (size_t)(lead * AUDIO_RATE);
    float *event = calloc(MAX_SAMPLES, sizeof(float));
    float seconds = 0;
    float level = SYN_LEVEL * powf(10.0f, c->db / 20.0f);
    syn_chime_t other;
    switch (kind) {
    case N_OTHER:
        do syn_chime(&other, r); while (syn_contains_tune(&other, home));
        if (verbose)
            printf("other: %u notes %.0f/%.0f/%.0f vs home %.0f/%.0f/%.0f\n", other.notes, (double)other.hz[0], (double)other.hz[1],
                   (double)(other.notes > 2 ? other.hz[2] : 0), (double)home->hz[0], (double)home->hz[1], (double)(home->notes > 2 ? home->hz[2] : 0));
        syn_render(&other, event, MAX_SAMPLES, 0); seconds = other.duration; break;
    case N_SWAP:
        other = *home; syn_swap(&other);
        syn_render(&other, event, MAX_SAMPLES, 0); seconds = other.duration; break;
    case N_VOWEL: syn_speech(event, MAX_SAMPLES, 0, 2.5f, r); seconds = 2.6f; break;
    case N_MUSIC: syn_music(event, MAX_SAMPLES, 0, 4.0f, r); seconds = 4.7f; break;
    case N_KNOCK: syn_knock(event, MAX_SAMPLES, 0, r); seconds = 1.5f; break;
    case N_WHITE: {
        size_t len = (size_t)(1.5f * AUDIO_RATE);
        for (size_t i = 0; i < len; ++i)
            event[i] = syn_gauss(r) * fminf(1.0f, fminf((float)i, (float)(len - i)) / 320.0f);
        seconds = 1.5f; break;
    }
    case P_REPEAT: {
        float again = syn_uniform(r, 1.0f, 1.4f);
        syn_render(home, event, MAX_SAMPLES, 0);
        syn_render(home, event, MAX_SAMPLES, again);
        seconds = again + home->duration; break;
    }
    default: syn_render(home, event, MAX_SAMPLES, 0); seconds = home->duration; break;
    }
    size_t length = (size_t)(seconds * AUDIO_RATE);
    if (kind == P_TILT_UP) syn_tilt_up(event, length);
    if (kind == P_TILT_DOWN) syn_tilt_down(event, length);
    if (kind == P_REVERB) { length += AUDIO_RATE / 2; syn_reverb(event, length, r); }
    if (!positive(kind)) level = SYN_LEVEL * powf(10.0f, syn_uniform(r, -10.0f, 6.0f) / 20.0f);
    syn_scale(event, length, level);
    size_t total = *onset + length + (size_t)(tail * AUDIO_RATE);
    for (size_t i = 0; i < length; ++i) buffer[*onset + i] = event[i];
    free(event);
    syn_add_pink(buffer, total, SYN_ROOM, r);
    if (kind == P_PINK) syn_add_pink(buffer, total, level / powf(10.0f, c->snr / 20.0f), r);
    if (kind == P_BABBLE) syn_add_babble(buffer, total, level / powf(10.0f, c->snr / 20.0f), r);
    syn_to_pcm(buffer, pcm, total);
    return total - total % AUDIO_FRAME;
}

static bool enroll_new(const syn_chime_t *home, syn_rng_t *r)
{
    size_t total = (size_t)(5.0f * AUDIO_RATE) + (size_t)(home->duration * AUDIO_RATE);
    memset(buffer, 0, sizeof(buffer));
    float *event = calloc(MAX_SAMPLES, sizeof(float));
    syn_render(home, event, MAX_SAMPLES, 0);
    size_t length = (size_t)(home->duration * AUDIO_RATE);
    syn_scale(event, length, SYN_LEVEL);
    for (size_t i = 0; i < length; ++i) buffer[(size_t)(2.5f * AUDIO_RATE) + i] = event[i];
    free(event);
    syn_add_pink(buffer, total, SYN_ROOM, r);
    syn_to_pcm(buffer, pcm, total);
    return chime_enroll_from_pcm(&enroll, &dsp, pcm, (uint32_t)(total - total % AUDIO_FRAME)) == CHIME_ENROLL_EV_DONE;
}

static void old_feed(size_t samples)
{
    for (size_t at = 0; at + AUDIO_FRAME <= samples; at += AUDIO_FRAME) old_push(&old_home, &dsp, pcm + at);
}
static bool enroll_old(const syn_chime_t *home, syn_rng_t *r)
{
    memset(&old_home, 0, sizeof(old_home));
    old_begin_enroll(&old_home);
    memset(buffer, 0, sizeof(buffer));
    size_t total = (size_t)(5.5f * AUDIO_RATE);
    syn_add_pink(buffer, total, SYN_ROOM, r);
    syn_to_pcm(buffer, pcm, total);
    old_feed(total);
    static const float gains[4] = {1.0f, 0.9f, 1.1f, 1.0f}; /* three rings and the verification */
    for (unsigned k = 0; k < 4; ++k) {
        memset(buffer, 0, sizeof(buffer));
        size_t length = (size_t)(home->duration * AUDIO_RATE);
        syn_render(home, buffer, MAX_SAMPLES, 0.2f);
        syn_scale(buffer, length + AUDIO_RATE / 5, SYN_LEVEL * gains[k]);
        total = length + (size_t)(1.7f * AUDIO_RATE);
        syn_add_pink(buffer, total, SYN_ROOM, r);
        syn_to_pcm(buffer, pcm, total);
        old_feed(total);
    }
    return old_home.valid;
}

static void score_clip(size_t samples, size_t onset, bool new_ok, bool old_ok, const condition_t *c, tally_t *t)
{
    unsigned new_count = 0, old_count = 0;
    long new_first = -1, old_first = -1;
    float best = FLT_MAX;
    if (new_ok) {
        chime_detector_init(&detector, &enroll.model);
        for (size_t at = 0; at + AUDIO_FRAME <= samples; at += AUDIO_FRAME) {
            chime_result_t r;
            if (chime_detector_push(&detector, &dsp, pcm + at, enroll.model.threshold, &r) == CHIME_DETECTED) {
                if (!new_count++) new_first = (long)(at + AUDIO_FRAME);
            }
            if (r.frames && r.score < best) best = r.score;
        }
        if (verbose && !positive(c->kind) && new_count) printf("FALSE %s best/thr %.2f\n", c->name, (double)(best / enroll.model.threshold));
        if (verbose && positive(c->kind) && !new_count) {
            const chime_cell_t *e = &detector.column[0][enroll.model.length - 1];
            printf("miss %s: best/thr %.2f template_loud %u\n", c->name, (double)(best / enroll.model.threshold), detector.template_loud);
            (void)e;
        }
    }
    if (old_ok) {
        old_run = old_home;
        for (size_t at = 0; at + AUDIO_FRAME <= samples; at += AUDIO_FRAME)
            if (old_push(&old_run, &dsp, pcm + at) && !old_count++) old_first = (long)(at + AUDIO_FRAME);
    }
    ++t->clips;
    if (positive(c->kind)) {
        if (new_count) {
            ++t->new_hits; t->new_extra += new_count - 1;
            t->new_latency += (double)(new_first - (long)onset) / AUDIO_RATE; ++t->new_latency_n;
        }
        if (old_count) {
            ++t->old_hits; t->old_extra += old_count - 1;
            t->old_latency += (double)(old_first - (long)onset) / AUDIO_RATE; ++t->old_latency_n;
        }
    } else {
        t->new_events += new_count; t->old_events += old_count;
        if (new_ok && best / enroll.model.threshold < t->new_closest) t->new_closest = best / enroll.model.threshold;
    }
}

static void write_wav(const char *path, const int16_t *samples, uint32_t count)
{
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); exit(1); }
    uint8_t header[44];
    audio_wav_header(header, count);
    fwrite(header, 1, 44, f);
    fwrite(samples, 2, count, f); /* little-endian host */
    fclose(f);
}

static int wav_demo(const char *dir)
{
    syn_rng_t r = {1};
    syn_chime_t home; syn_chime(&home, &r);
    char path[512];
    /* enroll.wav: 2.5 s of room noise, the ring, then quiet. */
    size_t total = (size_t)(5.0f * AUDIO_RATE) + (size_t)(home.duration * AUDIO_RATE);
    memset(buffer, 0, sizeof(buffer));
    syn_render(&home, buffer + (size_t)(2.5f * AUDIO_RATE), MAX_SAMPLES - (size_t)(2.5f * AUDIO_RATE), 0);
    syn_scale(buffer, total, SYN_LEVEL);
    syn_add_pink(buffer, total, SYN_ROOM, &r);
    syn_to_pcm(buffer, pcm, total);
    snprintf(path, sizeof(path), "%s/enroll.wav", dir);
    write_wav(path, pcm, (uint32_t)total);
    /* target.wav: another sound, then the chime at -10 dB in pink noise. */
    memset(buffer, 0, sizeof(buffer));
    total = 9u * AUDIO_RATE;
    syn_knock(buffer, total, AUDIO_RATE, &r);
    float *event = calloc(MAX_SAMPLES, sizeof(float));
    syn_render(&home, event, MAX_SAMPLES, 0);
    syn_scale(event, (size_t)(home.duration * AUDIO_RATE), SYN_LEVEL * 0.316f);
    for (size_t i = 0; i < (size_t)(home.duration * AUDIO_RATE); ++i) buffer[4u * AUDIO_RATE + i] += event[i];
    free(event);
    syn_add_pink(buffer, total, SYN_ROOM * 5, &r);
    syn_to_pcm(buffer, pcm, total);
    snprintf(path, sizeof(path), "%s/target.wav", dir);
    write_wav(path, pcm, (uint32_t)total);
    printf("wrote %s/enroll.wav and %s/target.wav (chime at 4.0 s)\n", dir, dir);
    return 0;
}

int main(int argc, char **argv)
{
    audio_dsp_init(&dsp);
    if (argc == 3 && !strcmp(argv[1], "--wav")) return wav_demo(argv[2]);
    uint64_t seed_base = 1000;
    bool check = false;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "-v")) verbose = true;
        else if (!strcmp(argv[i], "--check")) check = true;
        else if (!strcmp(argv[i], "--seed") && i + 1 < argc) seed_base = strtoull(argv[++i], NULL, 10);
        else { fprintf(stderr, "usage: chime_eval [-v] [--seed N] [--check] | --wav DIR\n"); return 2; }
    }
    tally_t tally[CONDITIONS];
    memset(tally, 0, sizeof(tally));
    for (unsigned c = 0; c < CONDITIONS; ++c) tally[c].new_closest = FLT_MAX;
    unsigned new_enrolled = 0, old_enrolled = 0;
    float threshold_sum = 0, template_sum = 0;
    for (unsigned h = 0; h < HOUSEHOLDS; ++h) {
        syn_rng_t r = {seed_base + h};
        syn_chime_t home; syn_chime(&home, &r);
        bool new_ok = enroll_new(&home, &r), old_ok = enroll_old(&home, &r);
        new_enrolled += new_ok; old_enrolled += old_ok;
        if (new_ok) { threshold_sum += enroll.model.threshold; template_sum += (float)enroll.model.length; }
        if (verbose)
            printf("home %2u: %u notes %.0f/%.0f/%.0f Hz tau %.2f; new %s (len %u, worst %.3f, thr %.3f, noise %.3f) old %s (thr %.3f)\n",
                   h, home.notes, (double)home.hz[0], (double)home.hz[1], (double)(home.notes > 2 ? home.hz[2] : 0),
                   (double)home.tau[0], new_ok ? "ok" : chime_reason_text(enroll.reason), (unsigned)enroll.model.length,
                   (double)enroll.worst, (double)enroll.model.threshold, (double)enroll.noise_score,
                   old_ok ? "ok" : "FAILED", (double)old_home.enrolling.threshold);
        for (unsigned c = 0; c < CONDITIONS; ++c) {
            for (unsigned k = 0; k < TRIALS; ++k) {
                syn_rng_t cr = {((seed_base + h) << 32) ^ ((uint64_t)c << 16) ^ k};
                size_t onset, samples = render(conditions[c].kind, &conditions[c], &home, &cr, &onset);
                score_clip(samples, onset, new_ok, old_ok, &conditions[c], &tally[c]);
            }
        }
    }
    printf("\n合成データの評価（%u 家庭 x 各条件 %u 回、固定シード %llu）\n", HOUSEHOLDS, TRIALS, (unsigned long long)seed_base);
    printf("登録の成功: 新 %u/%u（1回鳴らす）、旧 %u/%u（3回＋確認1回）。新のしきい値の平均 %.3f、テンプレート平均 %.2f 秒\n\n",
           new_enrolled, HOUSEHOLDS, old_enrolled, HOUSEHOLDS,
           (double)(new_enrolled ? threshold_sum / new_enrolled : 0), (double)(new_enrolled ? template_sum / new_enrolled * 0.02f : 0));
    printf("| 正例の条件 | 回数 | 旧 検出率 | 新 検出率 | 旧 重複 | 新 重複 | 旧 遅延 | 新 遅延 |\n|---|---|---|---|---|---|---|---|\n");
    bool pass = true;
    for (unsigned c = 0; c < CONDITIONS; ++c) {
        const tally_t *t = &tally[c];
        if (!positive(conditions[c].kind)) continue;
        double nr = 100.0 * t->new_hits / t->clips, orr = 100.0 * t->old_hits / t->clips;
        printf("| %s | %u | %.1f%% | %.1f%% | %u | %u | %.2f s | %.2f s |\n", conditions[c].name, t->clips, orr, nr,
               t->old_extra, t->new_extra, t->old_latency_n ? t->old_latency / t->old_latency_n : 0.0,
               t->new_latency_n ? t->new_latency / t->new_latency_n : 0.0);
        bool target = conditions[c].kind != P_PINK && conditions[c].kind != P_BABBLE ? true : conditions[c].snr >= 10;
        if (target && (nr < 98.0 || t->new_extra)) pass = false;
    }
    printf("\n| 負例の条件 | 回数 | 旧 誤検出 | 新 誤検出 | 新 最小スコア/しきい値 |\n|---|---|---|---|---|\n");
    for (unsigned c = 0; c < CONDITIONS; ++c) {
        const tally_t *t = &tally[c];
        if (positive(conditions[c].kind)) continue;
        printf("| %s | %u | %u | %u | %.2f |\n", conditions[c].name, t->clips, t->old_events, t->new_events, (double)t->new_closest);
        if (t->new_events) pass = false;
    }
    printf("\n遅延はチャイムの鳴り始めから検出まで（平均）。重複は1回の鳴動で2回以上検出した回数。\n");
    printf("合格の目安（SN比10dB以上の正例で検出率98%%以上・重複なし、負例の誤検出0件）: %s\n", pass ? "満たした" : "満たしていない");
    return check && !pass ? 1 : 0;
}
