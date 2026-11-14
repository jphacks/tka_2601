/* Registers a chime from one WAV and lists where it is detected in another,
 * with the firmware's own code (audio_core.c, chime_detector.c).
 *
 *   bash run.sh wav ENROLL.wav TARGET.wav [--margin PERCENT] [-v]
 *
 * Both files: 16 kHz, mono, 16-bit PCM. ENROLL.wav starts with at least 2 s of
 * background (as the board measures before asking for the ring), then one ring.
 * -v also prints, for each sound that ended without a detection, its best score.
 * For recordings from the real board (#48); synthetic WAVs say nothing about
 * field performance. */
#include "chime_detector.h"
#include <float.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t le32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }

static int16_t *read_wav(const char *path, uint32_t *samples)
{
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return NULL; }
    uint8_t head[12], chunk[8];
    int16_t *pcm = NULL;
    bool format_ok = false;
    if (fread(head, 1, 12, f) != 12 || memcmp(head, "RIFF", 4) || memcmp(head + 8, "WAVE", 4)) {
        fprintf(stderr, "%s: not a RIFF/WAVE file\n", path); goto done;
    }
    while (fread(chunk, 1, 8, f) == 8) {
        uint32_t size = le32(chunk + 4);
        if (!memcmp(chunk, "fmt ", 4)) {
            uint8_t fmt[16];
            if (size < 16 || fread(fmt, 1, 16, f) != 16) break;
            format_ok = le16(fmt) == 1 && le16(fmt + 2) == 1 && le32(fmt + 4) == AUDIO_RATE && le16(fmt + 14) == 16;
            if (fseek(f, (long)(size - 16 + (size & 1u)), SEEK_CUR)) break;
        } else if (!memcmp(chunk, "data", 4)) {
            if (!format_ok) break;
            *samples = size / 2u;
            pcm = malloc((size_t)*samples * sizeof(int16_t) + 1);
            uint8_t *raw = (uint8_t *)pcm;
            if (!pcm || fread(raw, 1, (size_t)*samples * 2u, f) != (size_t)*samples * 2u) { free(pcm); pcm = NULL; break; }
            for (uint32_t i = 0; i < *samples; ++i) pcm[i] = (int16_t)le16(raw + 2u * i);
            goto done;
        } else if (fseek(f, (long)(size + (size & 1u)), SEEK_CUR)) break;
    }
    fprintf(stderr, "%s: need 16 kHz mono 16-bit PCM\n", path);
done:
    fclose(f);
    return pcm;
}

static audio_dsp_t dsp;
static chime_enroll_t enroll;
static chime_detector_t detector;

int main(int argc, char **argv)
{
    unsigned margin = 100;
    bool verbose = false;
    const char *files[2] = {NULL, NULL};
    unsigned count = 0;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--margin") && i + 1 < argc) margin = (unsigned)atoi(argv[++i]);
        else if (!strcmp(argv[i], "-v")) verbose = true;
        else if (count < 2) files[count++] = argv[i];
        else count = 3;
    }
    if (count != 2 || margin < 50 || margin > 200) {
        fprintf(stderr, "usage: chime_eval_wav ENROLL.wav TARGET.wav [--margin 50..200] [-v]\n");
        return 2;
    }
    uint32_t enroll_samples = 0, target_samples = 0;
    int16_t *enroll_pcm = read_wav(files[0], &enroll_samples);
    int16_t *target_pcm = read_wav(files[1], &target_samples);
    if (!enroll_pcm || !target_pcm) return 1;
    audio_dsp_init(&dsp);
    chime_enroll_event_t result = chime_enroll_from_pcm(&enroll, &dsp, enroll_pcm, enroll_samples);
    if (result != CHIME_ENROLL_EV_DONE) {
        printf("registration failed: %s\n", result == CHIME_ENROLL_EV_FAILED ? chime_reason_text(enroll.reason)
                                                                           : "no complete sound after the first 2 s");
        return 1;
    }
    const audio_model_t *model = &enroll.model;
    float limit = model->threshold * (float)margin / 100.0f;
    printf("registered: template %.2f s, gate %.0f, worst variant %.3f, background %.3f, threshold %.3f (margin %u%% -> %.3f)\n",
           model->length * 0.02, (double)model->gate_rms, (double)enroll.worst,
           (double)(enroll.noise_score < FLT_MAX ? enroll.noise_score : -1.0f), (double)model->threshold, margin, (double)limit);
    chime_detector_init(&detector, model);
    unsigned detections = 0;
    for (uint32_t at = 0; at + AUDIO_FRAME <= target_samples; at += AUDIO_FRAME) {
        chime_result_t r;
        chime_event_t e = chime_detector_push(&detector, &dsp, target_pcm + at, limit, &r);
        double seconds = (double)(at + AUDIO_FRAME) / AUDIO_RATE;
        if (e == CHIME_DETECTED) {
            ++detections;
            printf("detected at %7.2f s  score %.3f  matched %.2f s (from %.2f s)\n", seconds, (double)r.score,
                   r.frames * 0.02, seconds - r.frames * 0.02);
        } else if (e == CHIME_SOUND_END && verbose) {
            printf("sound ended at %6.2f s  best %.3f (not detected)\n", seconds, (double)r.score);
        }
    }
    printf("%u detection(s) in %.1f s\n", detections, (double)target_samples / AUDIO_RATE);
    free(enroll_pcm); free(target_pcm);
    return 0;
}
