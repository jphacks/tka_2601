#include "audio_app.h"
#include "audio_link.h"
#include "audio_store.h"
#include "audio_upload.h"
#include "net_state.h"
#include "net_stream.h"
#include "storage_worker.h"
#include "tune.h"
#include "voice_capture.h"
#include "voice_stream.h"
#include "voice_noise.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static audio_ring_t ring;
static int16_t pending[AUDIO_CLIP_SAMPLES];
static uint8_t flash[AUDIO_STORE_BYTES];
static uint32_t clock_ms;
static unsigned margin=100u;
static bool call_busy, network_ready, upload_ok, upload_configured;
static unsigned uploads;
uint32_t tune_chime_margin(void) { return margin; }
uint32_t tune_voice_gate(void) { return 600u; }
uint32_t tune_speaker_volume(void) { return 70u; }
bool voice_stream_busy(void) { return call_busy; }
bool net_voice_ready(void) { return network_ready; }
uint32_t net_now_ms(void) { return clock_ms; }
void net_sleep_ms(uint32_t ms) { clock_ms+=ms; }
void net_random(void *out, size_t n) { memset(out,0x5a,n); }
bool audio_upload_configured(void) { return upload_configured; }
bool audio_upload(audio_store_t *store, unsigned slot) { (void)store; (void)slot; ++uploads; return upload_ok; }
static char posted[4]; static unsigned posted_count;
bool audio_app_post_command(char command) { if (posted_count==4u) return false; posted[posted_count++]=command; return true; }
static bool flash_read(uint32_t off, void *out, size_t n)
{ if (off>sizeof(flash)||n>sizeof(flash)-off) return false; memcpy(out,flash+off,n); return true; }
static bool flash_write(uint32_t off, const void *data, size_t n)
{
    if (off>sizeof(flash)||n>sizeof(flash)-off) return false;
    const uint8_t *p=data;
    for (size_t i=0;i<n;++i) { assert((flash[off+i]&p[i])==p[i]); flash[off+i]&=p[i]; }
    return true;
}
static bool flash_erase(uint32_t off, size_t n)
{ assert(off%AUDIO_SLOT_SIZE==0 && n%AUDIO_SLOT_SIZE==0); memset(flash+off,255,n); return true; }
static const audio_flash_t driver={flash_read,flash_write,flash_erase};

/* Synthetic signal: a low tone then a high tone, or the reverse. */
static int16_t frame[AUDIO_FRAME];
static void tone(unsigned f, unsigned total, float gain, bool reverse, uint32_t *seed)
{
    float hz=((f>=total/2)!=reverse)?880.0f:1320.0f;
    for (unsigned i=0;i<AUDIO_FRAME;++i) {
        *seed=*seed*1664525u+1013904223u;
        float noise=(float)((int32_t)(*seed>>16)-32768)/32768.0f;
        float v=gain*(sinf(6.2831853f*hz*(float)(f*AUDIO_FRAME+i)/AUDIO_RATE)+0.005f*noise);
        frame[i]=(int16_t)fmaxf(-32768.0f,fminf(32767.0f,v));
    }
}
static void step(bool gap)
{
    audio_app_service();
    audio_app_frame(frame,gap);
    audio_app_service();
}
static void silence(unsigned frames)
{
    memset(frame,0,sizeof(frame));
    for (unsigned i=0;i<frames;++i) step(false);
}
static void ring_bell(unsigned frames, float gain, bool reverse)
{
    uint32_t seed=12345;
    for (unsigned f=0;f<frames;++f) { tone(f,frames,gain,reverse,&seed); step(false); }
    silence(30); /* end of the sound: 0.5 s below the gate */
}
static void start(bool record_clips)
{
    memset(flash,255,sizeof(flash));
    memset((void *)audio_link(),0,sizeof(audio_link_t));
    audio_app_init(&ring,pending,record_clips);
    storage_worker_begin(driver,true);
    clock_ms=1000; call_busy=false; network_ready=false; uploads=0; margin=100;
    silence(50); /* warm-up is ignored */
}
#define GAP 160u /* more than the 3 s refractory time between rings */
static void enroll(void)
{
    assert(audio_storage_ready());
    audio_app_command('e');
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_NOISE);
    silence(100); /* 2 s of background */
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_LISTEN);
    ring_bell(50,8000,false); /* once: no second ring, no verification */
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_ANALYZE);
    assert(!audio_app_model_valid()); /* not active until the variants are checked */
    assert(audio_jobs.clip_busy && !audio_jobs.clip_saving); /* the ring's copy, not a recording */
    silence(100);
    assert(audio_app_model_valid());
    assert(!audio_jobs.clip_busy);
    assert(audio_jobs.model_busy && audio_app_enroll_status().phase == AUDIO_ENROLL_SAVING);
    storage_worker_step();
    assert(!audio_jobs.model_busy && audio_app_enroll_status().phase == AUDIO_ENROLL_DONE);
}
static void test_enroll_detect_and_restore(void)
{
    start(false);
    /* Registration needs an explicitly formatted partition. */
    assert(!audio_storage_ready());
    audio_app_command('e');
    silence(300);
    assert(!audio_app_model_valid() && audio_app_enroll_status().phase == AUDIO_ENROLL_IDLE);
    audio_app_command('F');
    assert(audio_jobs.formatting);
    storage_worker_step();
    assert(!audio_jobs.formatting && audio_storage_ready());
    enroll();
    volatile audio_link_t *link=audio_link();
    silence(GAP);
    uint32_t events=link->event_seq;
    ring_bell(50,5000,false);
    assert(link->event_seq==events+1u && link->detected_count==1u);
    assert(link->last_score<=audio_app_threshold());
    silence(GAP);
    /* A different sound is not the chime; its best score is reported when it ends. */
    ring_bell(50,8000,true);
    assert(link->event_seq==events+1u);
    float reversed=link->last_score;
    assert(reversed>audio_app_threshold());
    silence(GAP);
    /* margin scales the enrolled threshold at runtime, in both directions. */
    margin=50u;
    ring_bell(50,5000,false);
    float own=link->last_score;
    assert(link->event_seq==events+1u+(own<=audio_app_threshold()*0.5f?1u:0u));
    silence(GAP);
    events=link->event_seq;
    margin=(unsigned)ceilf(100.0f*own/audio_app_threshold())+1u;
    assert(margin<=200u);
    ring_bell(50,5000,false);
    assert(link->event_seq==events+1u);
    silence(GAP);
    margin=100u;
    /* Too short is not the chime. Ringing on past 4 s is still detected, once,
     * without waiting for the end of the sound. */
    events=link->event_seq;
    ring_bell(5,8000,false); assert(link->event_seq==events);
    silence(GAP);
    {
        uint32_t seed=12345;
        for (unsigned f=0;f<AUDIO_MAX_FRAMES+5;++f) { tone(f,AUDIO_MAX_FRAMES+5,8000,false,&seed); step(false); }
        assert(link->event_seq==events+1u); /* detected while still sounding */
        silence(30);
    }
    silence(GAP);
    /* Power cycle: the model comes back from flash. */
    float threshold=audio_app_threshold();
    audio_app_init(&ring,pending,false);
    assert(!audio_app_model_valid());
    storage_worker_begin(driver,true);
    assert(audio_app_model_valid() && audio_app_threshold()==threshold);
    silence(50); /* warm-up */
    events=link->event_seq;
    ring_bell(50,5000,false);
    assert(link->event_seq==events+1u); /* the loaded model detects */
    silence(GAP);
    /* Registration and cancel leave the old model alone. */
    audio_app_command('e'); silence(100); audio_app_command('x');
    assert(audio_app_model_valid() && audio_app_threshold()==threshold);
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_CANCELLED);
    /* Cancel while the ring is being checked releases the copy of the ring. */
    audio_app_command('e'); silence(100); ring_bell(50,8000,false);
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_ANALYZE && audio_jobs.clip_busy);
    audio_app_command('x');
    assert(!audio_jobs.clip_busy && audio_app_threshold()==threshold);
    /* A click is too short: the board asks for the ring again and keeps listening. */
    audio_app_command('e'); silence(100);
    ring_bell(5,8000,false);
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_LISTEN && audio_app_enroll_status().reason == CHIME_REASON_SHORT);
    /* A capture gap ends registration. */
    step(true);
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_FAILED && audio_app_threshold()==threshold);
    silence(60);
    /* Too loud a background: the gate would pass 16000. */
    audio_app_command('e');
    {
        uint32_t seed=99;
        for (unsigned f=0;f<100;++f) {
            for (unsigned i=0;i<AUDIO_FRAME;++i) { seed=seed*1664525u+1013904223u; frame[i]=(int16_t)((int32_t)(seed>>16)-32768); }
            step(false);
        }
    }
    assert(audio_app_enroll_status().phase == AUDIO_ENROLL_FAILED && audio_app_enroll_status().reason == CHIME_REASON_NOISY);
    assert(audio_app_model_valid() && audio_app_threshold()==threshold);
    /* The public entry points queue the same commands. */
    posted_count=0;
    assert(audio_app_enroll_start() && audio_app_enroll_cancel());
    assert(posted_count==2u && posted[0]=='e' && posted[1]=='x');
}
static void test_recording_is_opt_in(void)
{
    /* Default: nothing configured to send it to, so nothing reaches flash. */
    start(false);
    audio_app_command('F'); storage_worker_step();
    audio_app_command('r');
    silence(260);
    assert(!audio_jobs.clip_busy && !audio_jobs.clip_saving);
    enroll();
    silence(GAP);
    ring_bell(50,8000,false);
    silence(GAP);
    assert(audio_link()->event_seq==1u && !audio_jobs.clip_saving);
    for (unsigned slot=AUDIO_EVENT_FIRST_SLOT;slot<AUDIO_SLOT_COUNT;++slot) {
        audio_record_t header;
        assert(flash_read(slot*AUDIO_SLOT_SIZE,&header,sizeof(header)));
        assert(header.magic==UINT32_MAX);
    }
}
static void test_clip_saved_uploaded_and_deferred(void)
{
    start(true);
    upload_configured=true;
    audio_app_command('F'); storage_worker_step();
    enroll();
    silence(GAP);
    ring_bell(50,8000,false);
    /* The event is published before the tail so the call never waits. */
    assert(audio_link()->event_seq==1u);
    assert(!audio_jobs.clip_saving);
    silence(20);
    assert(audio_jobs.clip_saving);
    /* The clip: 1 s before the match, the match, 1 s after. */
    assert(audio_jobs.pending_samples>=(AUDIO_PRE_FRAMES+38u+AUDIO_POST_FRAMES)*AUDIO_FRAME);
    assert(audio_jobs.pending_samples<=AUDIO_CLIP_SAMPLES);
    /* A flash save waits for the end of a call. */
    call_busy=true; storage_worker_step(); assert(audio_jobs.clip_saving);
    call_busy=false; storage_worker_step();
    assert(!audio_jobs.clip_saving && !audio_jobs.clip_busy);
    /* Failed upload retries later and keeps the recording. */
    network_ready=true; upload_ok=false;
    storage_worker_step(); assert(uploads==1u);
    storage_worker_step(); assert(uploads==1u);
    clock_ms+=30000u; upload_ok=true;
    storage_worker_step(); assert(uploads==2u);
    clock_ms+=1000u;
    storage_worker_step(); assert(uploads==2u); /* acknowledged: nothing left */
    /* A manual recording goes the same way; corruption is quarantined, never uploaded. */
    network_ready=false;
    silence(60);
    audio_app_command('r'); silence(255);
    assert(audio_jobs.clip_saving);
    storage_worker_step();
    assert(!audio_jobs.clip_saving);
    flash[AUDIO_EVENT_FIRST_SLOT*AUDIO_SLOT_SIZE+AUDIO_BODY_OFFSET]^=1;
    network_ready=true;
    unsigned before=uploads;
    for (unsigned i=0;i<AUDIO_SLOT_COUNT;++i) { storage_worker_step(); clock_ms+=1000u; }
    assert(uploads==before);
    upload_configured=false;
}
static bool peer_listen(uint32_t turn)
{
    volatile audio_link_t *link=audio_link();
    link->voice_listen_turn=turn;
    link->voice_rms_gate=600u;
    link->voice_record_enabled=1u;
    uint32_t generation=link->voice_listen_seq+1u;
    link->voice_listen_seq=generation;
    audio_app_service();
    return link->voice_listen_ack==generation;
}
static void test_call_mailbox(void)
{
    start(true);
    upload_configured=false;
    volatile audio_link_t *link=audio_link();
    audio_app_command('F'); storage_worker_step();
    enroll();
    silence(GAP);
    /* While a chime's tail is being recorded the mic stays with it, then moves. */
    uint32_t seed=3;
    for (unsigned f=0;f<50;++f) { tone(f,50,8000,false,&seed); step(false); }
    silence(25); /* detected at the template's end; the clip's tail is pending */
    assert(link->event_seq==1u && !audio_jobs.clip_saving);
    link->voice_call_active=1u;
    audio_app_service();
    assert(link->voice_call_ack==0u);
    silence(25);
    assert(audio_jobs.clip_saving);
    audio_app_service();
    assert(link->voice_call_ack==1u);
    /* Listening: gate, pre-roll, speech, then silence ends the utterance. */
    silence(10);
    assert(link->voice_write_seq==0u); /* muted until a listen request */
    assert(peer_listen(1u));
    silence(20);
    assert(link->voice_write_seq==0u); /* silence is never sent */
    seed=7;
    for (unsigned f=0;f<50;++f) { tone(f,50,8000,false,&seed); step(false); link->voice_read_seq=link->voice_write_seq; }
    assert(link->voice_write_seq>0u);
    silence(VOICE_CAPTURE_SILENCE_FRAMES);
    link->voice_read_seq=link->voice_write_seq;
    assert(link->voice_end_listen_seq==link->voice_listen_seq && link->voice_end_reason==VOICE_CAPTURE_END_SILENCE);
    assert(link->voice_samples==link->voice_write_seq*AUDIO_FRAME);
    /* No chime detection or recording during the call. */
    uint32_t events=link->event_seq;
    ring_bell(50,8000,false);
    assert(link->event_seq==events);
    /* A capture gap aborts the turn. */
    link->voice_record_enabled=0u; audio_app_service();
    assert(peer_listen(2u));
    seed=7;
    for (unsigned f=0;f<20;++f) { tone(f,50,8000,false,&seed); step(false); link->voice_read_seq=link->voice_write_seq; }
    step(true);
    assert(link->voice_end_reason==VOICE_CAPTURE_END_GAP && link->capture_errors==1u);
    /* Ring overflow aborts instead of sending a turn with holes. */
    link->voice_record_enabled=0u; audio_app_service();
    link->voice_read_seq=link->voice_write_seq;
    assert(peer_listen(3u));
    seed=7;
    for (unsigned f=0;f<80;++f) { tone(f,50,8000,false,&seed); step(false); }
    assert(link->voice_end_reason==VOICE_CAPTURE_END_OVERFLOW);
    /* End of call: mic released, chime detection back. */
    link->voice_read_seq=link->voice_write_seq;
    link->voice_record_enabled=0u;
    link->voice_call_active=0u;
    audio_app_service();
    assert(link->voice_call_ack==0u);
    /* The storage worker leaves flash alone while a call is coming up. */
    assert(audio_jobs.clip_saving);
    link->voice_call_active=1u; storage_worker_step();
    assert(audio_jobs.clip_saving);
    link->voice_call_active=0u; audio_app_service();
    storage_worker_step();
    assert(!audio_jobs.clip_saving);
}
static void test_loopback_and_meter(void)
{
    start(false);
    volatile audio_link_t *link=audio_link();
    uint32_t seed=1;
    audio_app_command('l');
    assert(link->loopback_failed==0u && link->loopback_samples==0u);
    for (unsigned f=0;f<150;++f) { tone(f,150,4000,false,&seed); step(false); }
    assert(link->loopback_samples==150u*AUDIO_FRAME && audio_jobs.clip_busy);
    assert(audio_jobs.pending_pcm[100]!=0);
    assert(link->last_rms>1000.0f && link->pcm_max>1000 && link->pcm_min<-1000);
    /* Stored nowhere: the clip job is not raised. */
    assert(!audio_jobs.clip_saving);
    /* Only one user of the pending buffer at a time. */
    audio_app_command('l');
    assert(link->loopback_failed==1u);
    audio_app_loopback_release();
    assert(link->loopback_samples==0u && !audio_jobs.clip_busy);
    link->loopback_failed=0u;
    /* A capture gap fails the recording instead of playing holes. */
    audio_app_command('l');
    silence(10); step(true);
    assert(link->loopback_failed==2u && link->loopback_samples==0u);
    link->loopback_failed=0u;
    /* A silent microphone is a microphone failure, not a busy board. */
    audio_app_command('l');
    audio_app_no_frame();
    assert(link->loopback_failed==2u);
    link->loopback_failed=0u;
    /* A lost microphone is reported, and recovers with the next frame. */
    audio_app_no_frame();
    assert(link->audio_status==2u);
    silence(1);
    assert(link->audio_status==1u);
}
static void test_optin_noise_mailbox(void)
{
    start(false);
    volatile audio_link_t *link=audio_link();
    audio_app_command('N');
    /* Profile from raw idle only, while the chime PCM and level meter stay raw. */
    uint32_t seed=31337;
    for(unsigned f=0;f<25;++f){audio_app_noise_background(frame,false);step(false);}
    voice_noise_status_t d;voice_noise_status(&d);
    assert(d.quiet_frames==0u && d.profiles==0u && !d.ready); /* External servo/calibration interlock. */
    for(unsigned f=0;f<25;++f) {
        for(unsigned i=0;i<AUDIO_FRAME;++i){seed=seed*1664525u+1013904223u;frame[i]=(int16_t)((int)(seed>>16)%41-20);}
        int16_t original[AUDIO_FRAME];memcpy(original,frame,sizeof(original));
        audio_app_noise_background(frame,true);assert(!memcmp(original,frame,sizeof(original)));
        step(false);
    }
    voice_noise_status(&d);assert(d.enabled && d.ready);
    link->voice_call_active=1u;audio_app_service();assert(peer_listen(1u));
    assert(voice_noise_active());
    audio_app_command('n');voice_noise_status(&d);assert(d.enabled); /* Cannot change mid-call. */
    for(unsigned f=0;f<VOICE_CAPTURE_MAX_FRAMES+12u;++f) {
        for(unsigned i=0;i<AUDIO_FRAME;++i)frame[i]=(int16_t)(1000+i);
        step(false);link->voice_read_seq=link->voice_write_seq;
    }
    assert(link->voice_end_reason==VOICE_CAPTURE_END_LIMIT);
    assert(link->voice_write_seq==VOICE_CAPTURE_MAX_FRAMES); /* Includes the2 tail frames, still30s. */
    assert(link->voice_samples==VOICE_CAPTURE_MAX_FRAMES*AUDIO_FRAME);
    assert(!voice_noise_active());
    link->voice_record_enabled=link->voice_call_active=0;audio_app_service();
    audio_app_command('n');voice_noise_status(&d);assert(!d.enabled);
    /* Not enough clean idle: ordinary, byte-identical speech has no delay. */
    start(false);audio_app_command('N');link=audio_link();
    link->voice_call_active=1u;audio_app_service();assert(peer_listen(1u));assert(!voice_noise_active());
    for(unsigned f=0;f<3;++f){for(unsigned i=0;i<AUDIO_FRAME;++i)frame[i]=(int16_t)(1000+i);step(false);}
    assert(link->voice_write_seq==3u);
    for(unsigned i=0;i<AUDIO_FRAME;++i)assert(link->voice_pcm[0][i]==frame[i]);
    link->voice_record_enabled=link->voice_call_active=0;audio_app_service();
}
int main(void)
{
    test_enroll_detect_and_restore();
    test_recording_is_opt_in();
    test_clip_saved_uploaded_and_deferred();
    test_call_mailbox();
    test_loopback_and_meter();
    test_optin_noise_mailbox();
    puts("PASS: one-ring enrollment and its failures, streaming detection, restore, recording opt-in, upload retry, call mailbox, loopback");
    return 0;
}
