#include "playback.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned starts, stops, writes;
static bool block_writes, fail_start;
static int16_t last_first;
static size_t last_samples;
static bool sink_start(void) { ++starts; return !fail_start; }
static bool sink_write(const int16_t *pcm, size_t samples)
{
    if (block_writes) return false;
    ++writes; last_first=pcm[0]; last_samples=samples; return true;
}
static void sink_stop(void) { ++stops; }
static const playback_sink_t sink={sink_start,sink_write,sink_stop,60u};
static uint32_t now=1000;
static void frames(unsigned first, unsigned count, size_t bytes)
{
    uint8_t pcm[640]={0};
    for (unsigned i=0;i<count;++i) {
        pcm[0]=(uint8_t)(first+i);
        assert(playback_push(pcm,bytes,now));
    }
}
static void run(unsigned steps) { for (unsigned i=0;i<steps;++i) playback_step(now); }
static void reset(void)
{
    starts=stops=writes=0; block_writes=fail_start=false;
    playback_init(&sink); now+=100000;
}
static void completed_playback(void)
{
    reset();
    assert(playback_idle() && !playback_done());
    assert(playback_open(now));
    assert(!playback_open(now)); /* one output at a time */
    frames(0,PLAYBACK_PREBUFFER_FRAMES-1,640);
    run(5);
    assert(starts==0 && writes==0); /* not enough prebuffer */
    assert(playback_credit()==PLAYBACK_PREBUFFER_FRAMES-1);
    frames(PLAYBACK_PREBUFFER_FRAMES-1,1,640);
    run(1); assert(starts==1);
    run(PLAYBACK_PREBUFFER_FRAMES);
    assert(writes==PLAYBACK_PREBUFFER_FRAMES && last_first==PLAYBACK_PREBUFFER_FRAMES-1);
    /* Drained input without END is never completion. */
    run(5);
    assert(!playback_done() && stops==0);
    playback_finish();
    run(3);
    assert(!playback_done());
    now+=59; run(1); assert(!playback_done() && stops==0);
    now+=1; run(1); assert(playback_done() && stops==1);
    assert(playback_idle());
    assert(playback_credit()==PLAYBACK_PREBUFFER_FRAMES);
    assert(playback_open(now) && !playback_done());
    playback_abort(); run(1); assert(playback_idle());
}
static void backpressure_and_credit(void)
{
    reset();
    assert(playback_open(now));
    uint8_t pcm[640]={0};
    frames(0,PLAYBACK_QUEUE_FRAMES,640);
    assert(playback_full());
    assert(!playback_push(pcm,640,now)); /* frame 65 stays in TCP */
    /* Credit stops before ring capacity and returns only as PCM is released. */
    assert(playback_credit()==PLAYBACK_CREDIT_FRAMES);
    run(2); /* start, first write */
    assert(writes==1 && playback_credit()==PLAYBACK_CREDIT_FRAMES+1);
    assert(!playback_full());
    playback_abort(); run(1);
    assert(playback_idle() && !playback_done() && stops==1);
    assert(playback_credit()<=PLAYBACK_QUEUE_FRAMES);
}
static void short_final_frame_and_invalid(void)
{
    reset();
    assert(playback_open(now));
    uint8_t pcm[2]={0xfe,0xff};
    assert(!playback_push(pcm,0,now));
    assert(!playback_push(pcm,1,now));
    assert(!playback_push(pcm,642,now));
    assert(playback_push(pcm,2,now));
    run(3);
    assert(writes==0); /* still below the prebuffer */
    playback_finish();
    run(2);
    assert(writes==1 && last_samples==1 && last_first==-2);
    assert(!playback_push(pcm,2,now)); /* nothing after the end */
    run(1); now+=60; run(1);
    assert(playback_done());
}
static void stalls_fail_with_a_reason(void)
{
    reset();
    /* Frozen speaker. */
    assert(playback_open(now));
    frames(0,1,640); playback_finish();
    block_writes=true;
    run(2); assert(playback_error()==NULL);
    now+=4999; run(1); assert(playback_error()==NULL);
    now+=1; run(1);
    assert(playback_error() && !strcmp(playback_error(),"speaker_progress_timeout"));
    assert(!playback_done() && stops==1 && playback_idle());
    /* Server stops sending before output_end. */
    block_writes=false;
    assert(playback_open(now) && playback_error()==NULL);
    frames(0,1,640);
    now+=14999; run(1); assert(playback_error()==NULL);
    now+=1; run(1);
    assert(playback_error() && !strcmp(playback_error(),"audio_progress_timeout"));
    /* Underrun rebuffers rather than completing, and resumes when data returns. */
    assert(playback_open(now));
    frames(0,PLAYBACK_PREBUFFER_FRAMES,640);
    run(1+PLAYBACK_PREBUFFER_FRAMES+1);
    assert(writes>=PLAYBACK_PREBUFFER_FRAMES && !playback_done());
    unsigned written=writes;
    frames(0,1,640); run(3); assert(writes==written); /* rebuffering */
    frames(1,PLAYBACK_PREBUFFER_FRAMES-1,640); run(2+PLAYBACK_PREBUFFER_FRAMES);
    assert(writes==written+PLAYBACK_PREBUFFER_FRAMES);
    /* A speaker that cannot start. */
    playback_abort(); run(1);
    fail_start=true;
    assert(playback_open(now));
    frames(0,PLAYBACK_PREBUFFER_FRAMES,640); run(1);
    assert(playback_error() && !strcmp(playback_error(),"speaker_start_failed"));
}
/* The call task can store a newer time just after the speaker task read the clock. */
static void clock_read_before_a_newer_store(void)
{
    reset();
    assert(playback_open(now));
    frames(0,PLAYBACK_PREBUFFER_FRAMES,640);
    uint32_t earlier=now-1u;
    (void)playback_step(earlier);
    assert(!playback_error());
    playback_abort();
}
int main(void)
{
    completed_playback(); backpressure_and_credit();
    short_final_frame_and_invalid(); stalls_fail_with_a_reason();
    clock_read_before_a_newer_store();
    puts("PASS: playback prebuffer, credit, backpressure, DMA drain, underrun and stall failure");
    return 0;
}
