/* Host harness: run the XIAO noise-suppression candidate and the XIAO RMS
 * endpointing on PCM files, exactly as the firmware calls them.
 *
 * Built by build_xiao.sh against firmware sources taken from a git ref
 * (default: codex/issue-72-noise-suppression). Files are raw PCM16 mono 16 kHz.
 *
 *   xiao_host ns   GATE GREETING_FRAMES idle.raw seg.raw out.raw
 *       voice_noise.c as in audio_app.c: learn from idle (eligible), then a call
 *       greeting (not eligible), voice_noise_begin(), filter seg, flush 2 frames.
 *       If the profile is not ready, seg is passed through unchanged (bypass).
 *   xiao_host core GATE GREETING_FRAMES idle.raw seg.raw out.raw
 *       voice_noise_core.c only, with the profile forced from the last 400 ms of
 *       idle (ignores the RMS ceiling). Shows the algorithm without the gate.
 *   xiao_host capture GATE 0 idle.raw seg.raw -
 *       voice_capture.c endpointing over: last 1 s of idle + seg + idle looped
 *       until 32 s. Prints start/end frames and end reason.
 * Prints one JSON object to stdout. */
#include "audio_core.h"
#include "voice_capture.h"
#include "voice_noise.h"
#include "voice_noise_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int16_t *load(const char *path, size_t *frames)
{
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(2); }
    fseek(f, 0, SEEK_END);
    long bytes = ftell(f);
    fseek(f, 0, SEEK_SET);
    *frames = (size_t)bytes / (AUDIO_FRAME * 2);
    int16_t *pcm = calloc(*frames ? *frames * AUDIO_FRAME : 1, 2);
    if (fread(pcm, 2, *frames * AUDIO_FRAME, f) != *frames * AUDIO_FRAME) { perror("read"); exit(2); }
    fclose(f);
    return pcm;
}

static double now_us(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}

typedef struct { int16_t *pcm; size_t frames, used; int started_at; } sink_t;
static size_t fed;

static bool sink(void *context, const int16_t pcm[AUDIO_FRAME])
{
    sink_t *s = context;
    if (s->started_at < 0) s->started_at = (int)fed;
    if (s->pcm && s->used < s->frames) memcpy(s->pcm + s->used * AUDIO_FRAME, pcm, AUDIO_FRAME * 2);
    ++s->used;
    return true;
}

int main(int argc, char **argv)
{
    if (argc != 7) { fprintf(stderr, "usage: xiao_host ns|core|capture GATE GREETING idle seg out\n"); return 2; }
    const char *mode = argv[1];
    uint32_t gate = (uint32_t)atoi(argv[2]);
    unsigned greeting = (unsigned)atoi(argv[3]);
    size_t idle_n, seg_n;
    int16_t *idle = load(argv[4], &idle_n), *seg = load(argv[5], &seg_n);
    static const int16_t quiet[AUDIO_FRAME] = {0};

    if (!strcmp(mode, "capture")) {
        size_t lead = idle_n < 50 ? idle_n : 50, total = 32u * AUDIO_RATE / AUDIO_FRAME;
        voice_capture_t cap;
        voice_capture_init(&cap);
        voice_capture_listen(&cap, gate);
        sink_t s = {0};
        s.started_at = -1;
        for (fed = 0; fed < total && cap.state != VOICE_CAPTURE_FINISHED; ++fed) {
            const int16_t *frame;
            if (fed < lead) frame = idle + (idle_n - lead + fed) * AUDIO_FRAME;
            else if (fed < lead + seg_n) frame = seg + (fed - lead) * AUDIO_FRAME;
            else frame = idle + ((fed - lead - seg_n) % idle_n) * AUDIO_FRAME;
            voice_capture_feed(&cap, frame, sink, &s);
        }
        /* started_at is the frame that tripped the gate; the pre-roll is emitted then. */
        printf("{\"lead_frames\":%zu,\"seg_frames\":%zu,\"started\":%s,\"trigger_frame\":%d,"
               "\"emitted_frames\":%u,\"end_frame\":%zu,\"end\":%d}\n",
               lead, seg_n, s.started_at >= 0 ? "true" : "false", s.started_at,
               cap.emitted_frames, fed, (int)cap.end);
        return 0;
    }

    FILE *out = fopen(argv[6], "wb");
    if (!out) { perror(argv[6]); return 2; }
    int16_t buf[AUDIO_FRAME];
    double cpu = 0;
    unsigned processed = 0;
    if (!strcmp(mode, "ns")) {
        voice_noise_init();
        voice_noise_enable(true);
        for (size_t i = 0; i < idle_n; ++i) { voice_noise_tick(); voice_noise_idle(idle + i * AUDIO_FRAME, true, gate); }
        for (unsigned i = 0; i < greeting; ++i) { voice_noise_tick(); voice_noise_idle(quiet, false, gate); }
        bool active = voice_noise_begin();
        for (size_t i = 0; i < seg_n + (active ? 2u : 0u); ++i) {
            const int16_t *in = i < seg_n ? seg + i * AUDIO_FRAME : quiet;
            double t0 = now_us();
            bool used = voice_noise_frame(in, buf);
            cpu += now_us() - t0;
            if (used) ++processed;
            fwrite(used ? buf : in, 2, AUDIO_FRAME, out);
        }
        voice_noise_status_t st;
        voice_noise_status(&st);
        voice_noise_end();
        printf("{\"active\":%s,\"profiles\":%u,\"rejected_frames\":%u,\"processed_frames\":%u,"
               "\"host_us_per_frame\":%.2f}\n", active ? "true" : "false", st.profiles,
               st.rejected_frames, processed, processed ? cpu / processed : 0.0);
    } else if (!strcmp(mode, "core")) {
        void *learn = voice_noise_core_create(), *stream = voice_noise_core_create();
        size_t first = idle_n > 20 ? idle_n - 20 : 0;
        for (size_t i = first; i < idle_n; ++i) {
            voice_noise_core_hop(learn, idle + i * AUDIO_FRAME, buf);
            voice_noise_core_hop(learn, idle + i * AUDIO_FRAME + 160, buf + 160);
        }
        bool ready = voice_noise_core_ready(learn);
        voice_noise_core_copy(stream, learn);
        for (size_t i = 0; i < seg_n + 2u; ++i) {
            const int16_t *in = i < seg_n ? seg + i * AUDIO_FRAME : quiet;
            double t0 = now_us();
            voice_noise_core_hop(stream, in, buf);
            voice_noise_core_hop(stream, in + 160, buf + 160);
            cpu += now_us() - t0;
            ++processed;
            fwrite(buf, 2, AUDIO_FRAME, out);
        }
        printf("{\"active\":%s,\"processed_frames\":%u,\"host_us_per_frame\":%.2f}\n",
               ready ? "true" : "false", processed, cpu / processed);
    } else {
        fprintf(stderr, "unknown mode %s\n", mode);
        return 2;
    }
    fclose(out);
    return 0;
}
