#include "voice_noise.h"
#include "voice_noise_core.h"
#include <math.h>
#include <string.h>

/* Fail open after a measured CPU overrun. Two FFT hops fit each20ms frame;
 * the first overrun makes subsequent frames use a cheap identical-delay path. */
#define FRAME_BUDGET_US 4000u
#define PROFILE_MAX_AGE_FRAMES 1500u
#define DELAY_SAMPLES 352u
static void *learning,*stream;
static voice_noise_status_t status;
static uint32_t ticks,profile_tick;
static uint32_t (*clock_us)(void);
static int16_t delayed[DELAY_SAMPLES];
static unsigned delay_cursor;
static int16_t discard[AUDIO_FRAME];

static uint32_t now(void){return clock_us?clock_us():0;}
static void measured(uint32_t began) {
 uint32_t elapsed=now()-began;
 if(elapsed>status.max_frame_us)status.max_frame_us=elapsed;
 if(clock_us && elapsed>FRAME_BUDGET_US){++status.over_budget_frames;status.budget_blocked=1;}
}
static void reject(void) {
 if(status.quiet_frames && learning)voice_noise_core_clear(learning);
 status.quiet_frames=0;++status.rejected_frames;
}
void voice_noise_init(void) {
 if(learning)voice_noise_core_destroy(learning);
 if(stream)voice_noise_core_destroy(stream);
 learning=stream=NULL;status=(voice_noise_status_t){0};ticks=profile_tick=0;clock_us=NULL;
 memset(delayed,0,sizeof(delayed));delay_cursor=0;
}
void voice_noise_clock(uint32_t (*fn)(void)){clock_us=fn;}
void voice_noise_enable(bool enabled) {
 if(status.active)return;
 status=(voice_noise_status_t){.enabled=enabled?1u:0u};
 if(learning)voice_noise_core_clear(learning);
 if(stream)voice_noise_core_clear(stream);

 if(enabled && (!learning || !stream)) {
  if(!learning)learning=voice_noise_core_create();
  if(!stream)stream=voice_noise_core_create();
  if(!learning || !stream)status.allocation_failed=1;
 }
}
void voice_noise_tick(void){++ticks;}
void voice_noise_idle(const int16_t raw[AUDIO_FRAME],bool eligible,uint32_t gate) {
 if(!status.enabled || status.active || status.allocation_failed || status.budget_blocked)return;
 if(!eligible){reject();return;}
 uint32_t began=now();
 double energy=0;int peak=0;
 for(unsigned i=0;i<AUDIO_FRAME;++i){int v=raw[i];energy+=(double)v*v;if(v<0)v=-v;if(v>peak)peak=v;}
 /* Same raw PCM domain as the tracked main voice path. Reject loud/transient candidates;
  *400ms consecutive idle is mandatory; no learning during any call/playback. */
 float ceiling=fminf(300.0f,(float)gate*.75f);
 float rms=(float)sqrt(energy/AUDIO_FRAME);
 if(rms<1.0f || rms>ceiling || peak>ceiling*6){reject();measured(began);return;}
 voice_noise_core_hop(learning,raw,discard);
 voice_noise_core_hop(learning,raw+160,discard+160);
 ++status.quiet_frames;
 if(voice_noise_core_ready(learning)) {
  voice_noise_core_copy(stream,learning);voice_noise_core_clear(learning);
  status.ready=1;++status.profiles;profile_tick=ticks;status.quiet_frames=0;
 }
 measured(began);
}
bool voice_noise_begin(void) {
 status.active=status.enabled && status.ready && !status.budget_blocked &&
  !status.allocation_failed && ticks-profile_tick<=PROFILE_MAX_AGE_FRAMES;
 status.profile_age_frames=ticks-profile_tick;
 memset(delayed,0,sizeof(delayed));delay_cursor=0;
 if(status.active)voice_noise_core_restart(stream);
 return status.active!=0;
}
bool voice_noise_active(void){return status.active!=0;}
bool voice_noise_frame(const int16_t pcm[AUDIO_FRAME],int16_t out[AUDIO_FRAME]) {
 if(!status.active){++status.bypass_frames;return false;}
 uint32_t began=now();
 /* Always maintain the same delay, including CPU fail-open, so bypass cannot
  *drop/repeat the beginning or jump forward to newer microphone samples. */
 for(unsigned i=0;i<AUDIO_FRAME;++i){discard[i]=delayed[delay_cursor];delayed[delay_cursor]=pcm[i];delay_cursor=(delay_cursor+1u)%DELAY_SAMPLES;}
 if(status.budget_blocked){memcpy(out,discard,sizeof(discard));++status.bypass_frames;return true;}
 voice_noise_core_hop(stream,pcm,out);voice_noise_core_hop(stream,pcm+160,out+160);
 ++status.processed_frames;measured(began);
 if(status.budget_blocked)memcpy(out,discard,sizeof(discard));
 return true;
}
void voice_noise_end(void){status.active=0;reject();}
void voice_noise_gap(void){status.ready=0;voice_noise_end();}
void voice_noise_status(voice_noise_status_t *out){
 *out=status;out->profile_age_frames=ticks-profile_tick;
 out->ready=status.enabled && status.ready && !status.budget_blocked && !status.allocation_failed &&
    out->profile_age_frames<=PROFILE_MAX_AGE_FRAMES;
}
