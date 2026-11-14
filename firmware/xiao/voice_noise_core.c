/* Experimental bounded streaming frontend. No text, recognizer, or clean PCM input.
 * Caller explicitly marks the first400ms as idle noise calibration. Never learn
 * a profile while a person or the device speaker is speaking. */
#include "voice_noise_core.h"
#include <math.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#define N 512u
#define HOP 160u
#define PROFILE_HOPS 40u
#define PI 3.14159265358979323846f
typedef struct {
 float input[N],real[N],imag[N],window[N],output[N],weight[N];
 float noise[N/2+1],gain[N/2+1];
 unsigned hops,profiles;
} noise_filter;
size_t voice_noise_core_bytes(void) { return sizeof(noise_filter); }
void *voice_noise_core_create(void) {
 noise_filter *s=calloc(1,sizeof(*s));
 if(s) for(unsigned i=0;i<N;++i) s->window[i]=sqrtf(.5f-.5f*cosf(2*PI*i/(N-1)));
 return s;
}
void voice_noise_core_destroy(void *s) {free(s);}
static void fft(float *real,float *imag,int inverse) {
 for(unsigned i=1,j=0;i<N;++i) {
  unsigned bit=N/2;for(;j&bit;bit>>=1)j^=bit;j^=bit;
  if(i<j){float t=real[i];real[i]=real[j];real[j]=t;t=imag[i];imag[i]=imag[j];imag[j]=t;}
 }
 for(unsigned n=2;n<=N;n<<=1) {
  float wr=cosf((inverse?2:-2)*PI/n),wi=sinf((inverse?2:-2)*PI/n);
  for(unsigned start=0;start<N;start+=n) {
   float r=1,im=0;
   for(unsigned j=0;j<n/2;++j) {
    unsigned a=start+j,b=a+n/2;
    float tr=r*real[b]-im*imag[b],ti=r*imag[b]+im*real[b];
    real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;
    float next=r*wr-im*wi;im=r*wi+im*wr;r=next;
   }
  }
 }
 if(inverse) for(unsigned i=0;i<N;++i){real[i]/=N;imag[i]/=N;}
}
void voice_noise_core_hop(void *state,const int16_t in[HOP],int16_t out[HOP]) {
 noise_filter *s=state;
 memmove(s->input,s->input+HOP,(N-HOP)*sizeof(float));
 for(unsigned i=0;i<HOP;++i)s->input[N-HOP+i]=in[i];
 for(unsigned i=0;i<N;++i){s->real[i]=s->input[i]*s->window[i];s->imag[i]=0;}
 fft(s->real,s->imag,0);++s->hops;
 if(s->hops<=PROFILE_HOPS) {
  if(s->hops>=4){++s->profiles;for(unsigned k=0;k<=N/2;++k){
   float power=s->real[k]*s->real[k]+s->imag[k]*s->imag[k];
   s->noise[k]+=(power-s->noise[k])/s->profiles;
  }}
  for(unsigned k=0;k<=N/2;++k)s->gain[k]=1;
 } else {
  float wanted[N/2+1];
  for(unsigned k=0;k<=N/2;++k){
   float power=s->real[k]*s->real[k]+s->imag[k]*s->imag[k];
   wanted[k]=sqrtf(fmaxf(.08f,1-1.25f*s->noise[k]/fmaxf(power,1)));
  }
  for(unsigned k=0;k<=N/2;++k){
   unsigned left=k?k-1:k,right=k<N/2?k+1:k;
   float smoothed=.25f*wanted[left]+.5f*wanted[k]+.25f*wanted[right];
   s->gain[k]=.6f*s->gain[k]+.4f*smoothed;
   s->real[k]*=s->gain[k];s->imag[k]*=s->gain[k];
   if(k && k<N/2){s->real[N-k]*=s->gain[k];s->imag[N-k]*=s->gain[k];}
  }
 }
 fft(s->real,s->imag,1);
 for(unsigned i=0;i<N;++i){
  s->output[i]+=s->real[i]*s->window[i];s->weight[i]+=s->window[i]*s->window[i];
 }
 for(unsigned i=0;i<HOP;++i){
  float value=s->weight[i]>.0001f?s->output[i]/s->weight[i]:0;
  value=fmaxf(-32768,fminf(32767,value));out[i]=(int16_t)lrintf(value);
 }
 memmove(s->output,s->output+HOP,(N-HOP)*sizeof(float));
 memmove(s->weight,s->weight+HOP,(N-HOP)*sizeof(float));
 memset(s->output+N-HOP,0,HOP*sizeof(float));memset(s->weight+N-HOP,0,HOP*sizeof(float));
}

void voice_noise_core_clear(void *state) {
 noise_filter *s=state;
 memset(s->input,0,sizeof(s->input));memset(s->real,0,sizeof(s->real));memset(s->imag,0,sizeof(s->imag));
 memset(s->output,0,sizeof(s->output));memset(s->weight,0,sizeof(s->weight));
 memset(s->noise,0,sizeof(s->noise));memset(s->gain,0,sizeof(s->gain));s->hops=s->profiles=0;
}
bool voice_noise_core_ready(const void *state) {return ((const noise_filter*)state)->hops>=PROFILE_HOPS;}
void voice_noise_core_copy(void *destination,const void *source) {
 noise_filter *d=destination;const noise_filter *s=source;
 if(d!=s)memcpy(d->noise,s->noise,sizeof(d->noise));
 memset(d->input,0,sizeof(d->input));memset(d->output,0,sizeof(d->output));memset(d->weight,0,sizeof(d->weight));
 for(unsigned i=0;i<=N/2;++i)d->gain[i]=1;
 d->hops=PROFILE_HOPS;d->profiles=s->profiles;
}
void voice_noise_core_restart(void *state) {voice_noise_core_copy(state,state);}
