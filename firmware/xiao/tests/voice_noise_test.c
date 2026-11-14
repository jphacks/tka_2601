#include "voice_noise.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
static int16_t input[AUDIO_FRAME],output[AUDIO_FRAME];
static uint32_t seed=20261114,clock_value;
static uint32_t slow_clock(void){clock_value+=5001u;return clock_value;}
static void background(unsigned frames,bool eligible) {
 while(frames--) {
  for(unsigned i=0;i<AUDIO_FRAME;++i){seed=seed*1664525u+1013904223u;input[i]=(int16_t)((int)(seed>>16)%41-20);}
  voice_noise_tick();voice_noise_idle(input,eligible,400);
 }
}
static voice_noise_status_t state(void){voice_noise_status_t s;voice_noise_status(&s);return s;}
int main(void) {
 voice_noise_init();memset(output,0x3a,sizeof(output));
 assert(!state().enabled && !voice_noise_begin());
 assert(!voice_noise_frame(input,output) && output[0]==0x3a3a); /* Caller retains exact raw PCM. */
 voice_noise_enable(true);background(50,false);assert(!state().ready && !voice_noise_begin());
 memset(input,0,sizeof(input));for(unsigned f=0;f<30;++f)voice_noise_idle(input,true,400);
 assert(!state().ready); /* Missing/zero samples cannot claim a usable profile. */
 background(19,true);assert(!state().ready);background(1,true);assert(state().ready);
 assert(voice_noise_begin());assert(state().active);
 voice_noise_end();voice_noise_gap();assert(!state().ready && !voice_noise_begin());
 voice_noise_enable(true);voice_noise_clock(slow_clock);background(1,true);
 assert(state().budget_blocked && !voice_noise_begin());
 /* No repeated expensive work after budget failure. */
 unsigned before=clock_value;background(100,true);assert(clock_value==before);
 voice_noise_clock(NULL);voice_noise_enable(true);background(20,true);assert(voice_noise_begin());
 voice_noise_clock(slow_clock);
 for(unsigned i=0;i<AUDIO_FRAME;++i)input[i]=(int16_t)(i+1);
 assert(voice_noise_frame(input,output));for(unsigned i=0;i<AUDIO_FRAME;++i)assert(output[i]==0);
 assert(state().budget_blocked);
 for(unsigned i=0;i<AUDIO_FRAME;++i)input[i]=(int16_t)(i+321);
 assert(voice_noise_frame(input,output));
 for(unsigned i=0;i<32;++i)assert(output[i]==0);
 for(unsigned i=32;i<AUDIO_FRAME;++i)assert(output[i]==(int16_t)(i-31)); /* No onset loss or jump after fail-open. */
 voice_noise_end();voice_noise_clock(NULL);
 voice_noise_enable(true);background(20,true);
 for(unsigned i=0;i<1501;++i)voice_noise_tick();assert(!voice_noise_begin() && !state().ready);
 voice_noise_enable(false);assert(!state().enabled && !voice_noise_begin());
 voice_noise_init();
 puts("PASS: optional noise OFF/default raw bypass, quiet/profile/gap/age gates, CPU fail-open without head loss, no repeated FFT after overrun");
}
