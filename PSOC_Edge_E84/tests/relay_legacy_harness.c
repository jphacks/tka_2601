#include "relay_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static voice_relay_t r;
static voice_header_t h;
static uint8_t payload[VOICE_PAYLOAD], wire[VOICE_PACKET];
static size_t n;
static uint8_t opcode;
static bool send_control(uint8_t type, uint32_t turn, uint32_t seq)
{
    voice_header_t c={.type=type,.session=42,.turn=turn,.sequence=seq};
    return voice_relay_encode(&r,&c,NULL,"11111111-1111-4111-8111-111111111111",
        "omakase","diagnostic-key",wire,sizeof(wire),&n,&opcode);
}
static int json(const char *s)
{ return voice_relay_decode(&r,1,(const uint8_t *)s,strlen(s),&h,payload); }
static int pending(uint32_t now)
{ return voice_relay_pending(&r,now,&h,payload); }
static void audio(uint32_t now)
{
    uint8_t pcm[640]={1}; r.clock_ms=now;
    assert(voice_relay_decode(&r,2,pcm,sizeof(pcm),&h,payload)==1);
}
static void unrecognized_audio_rearms_without_interrupting_thinking(void)
{
    memset(&r,0,sizeof(r));
    r.started=r.ready=r.legacy=r.call_started=r.input_active=r.listening=true;
    r.session=42; r.input_turn=1; r.input_frames=1; r.clock_ms=100;
    assert(send_control(VOICE_INPUT_END,1,1));
    assert(pending(20099)==0);
    assert(pending(20100)==1 && h.type==VOICE_NO_REPLY && h.turn==1);
    assert(pending(20100)==1 && h.type==VOICE_LISTEN && h.turn==2);
    assert(send_control(VOICE_INPUT_START,2,0));
    // A response starting late is framed as the current local turn so that
    // the E84 can stop the new microphone window before playing it.
    assert(json("{\"type\":\"agent_state\",\"state\":\"speaking\"}")==0);
    audio(20120); assert(h.type==VOICE_OUTPUT_START && h.turn==2 && !r.input_active);

    memset(&r,0,sizeof(r));
    r.started=r.ready=r.legacy=r.call_started=r.input_active=r.listening=true;
    r.session=42; r.input_turn=1; r.input_frames=1; r.clock_ms=100;
    assert(send_control(VOICE_INPUT_END,1,1));
    assert(json("{\"type\":\"agent_state\",\"state\":\"thinking\"}")==0);
    assert(pending(25100)==0 && r.waiting_reply); // slow ASR/LLM remains protected
    r.clock_ms=26000;
    assert(json("{\"type\":\"agent_state\",\"state\":\"listening\"}")==0);
    assert(pending(26499)==0);
    assert(pending(26500)==1 && h.type==VOICE_NO_REPLY);
}
int main(void)
{
    r.allow_legacy=true;
    assert(send_control(VOICE_HELLO,0,0)); assert(strstr((char*)wire,"\"protocol_version\":1"));
    assert(json("{\"type\":\"ready\"}")==1 && r.legacy && h.type==VOICE_READY);
    assert(send_control(VOICE_CALL_START,0,0) && !n);
    assert(json("{\"type\":\"agent_state\",\"state\":\"speaking\"}")==0);
    audio(100); assert(h.type==VOICE_OUTPUT_START && h.turn==0);
    assert(pending(100)==1 && h.type==VOICE_OUTPUT_AUDIO && h.sequence==0 && payload[0]==1);
    audio(120); assert(h.type==VOICE_OUTPUT_AUDIO && h.sequence==1);
    assert(pending(5000)==0); // a gap alone is never end-of-speech
    r.clock_ms=5010;
    assert(json("{\"type\":\"agent_state\",\"state\":\"listening\"}")==0);
    audio(5400); // tail PCM after the state change must be included
    assert(pending(5509)==0);
    assert(pending(5510)==1 && h.type==VOICE_OUTPUT_END && h.sequence==3);
    uint8_t noise[640]={1};
    assert(voice_relay_decode(&r,2,noise,sizeof(noise),&h,payload)==0); // comfort noise after listening
    assert(pending(7000)==0); // wait for actual M5 playback, not the server state
    assert(!send_control(VOICE_PLAYBACK_DONE,0,2));
    assert(send_control(VOICE_AUDIO_ACK,0,3) && !n);
    assert(send_control(VOICE_PLAYBACK_DONE,0,3) && !n);
    assert(pending(7000)==1 && h.type==VOICE_LISTEN && h.turn==1);
    assert(send_control(VOICE_INPUT_START,1,0) && !n);
    assert(voice_relay_decode(&r,2,noise,sizeof(noise),&h,payload)==0); // not a phantom response
    voice_header_t frame={.type=VOICE_INPUT_AUDIO,.session=42,.turn=1,.length=640};
    assert(voice_relay_encode(&r,&frame,payload,NULL,"omakase","diagnostic-key",wire,sizeof(wire),&n,&opcode));
    assert(opcode==2 && n==640);
    // LiveKit VAD can start its reply before the endpoint's 1.2s boundary.
    assert(json("{\"type\":\"agent_state\",\"state\":\"speaking\"}")==0);
    audio(7100); assert(h.type==VOICE_OUTPUT_START && h.turn==1 && !r.input_active);
    assert(pending(7100)==1 && h.sequence==0);
    assert(json("{\"type\":\"transcript\",\"speaker\":\"visitor\",\"text\":\"失礼いたします\"}")==0 && !r.closing);
    assert(json("{\"type\":\"transcript\",\"speaker\":\"ai\",\"text\":\"それでは失礼いたします。\"}")==0 && r.closing);
    r.clock_ms=7200;
    assert(json("{\"type\":\"agent_state\",\"state\":\"listening\"}")==0);
    assert(pending(7700)==1 && h.type==VOICE_OUTPUT_END && h.flags==1);
    assert(send_control(VOICE_PLAYBACK_DONE,1,1));
    assert(pending(7700)==1 && h.type==VOICE_CALL_END && h.turn==1);
    assert(send_control(VOICE_CALL_ENDED,1,0) && !strcmp((char*)wire,"{\"type\":\"end\"}"));
    assert(send_control(VOICE_CANCEL,1,0) && !strcmp((char*)wire,"{\"type\":\"end\"}"));

    memset(&r,0,sizeof(r)); r.allow_legacy=true;
    assert(send_control(VOICE_HELLO,0,0)); assert(json("{\"type\":\"ready\"}")==1);
    assert(send_control(VOICE_CALL_START,0,0));
    assert(json("{\"type\":\"transcript\",\"speaker\":\"ai\",\"text\":\"\\u5931\\u793c\\u3044\\u305f\\u3057\\u307e\\u3059\"}")==0 && r.closing);
    assert(json("{\"type\":\"agent_state\",\"state\":\"bogus\"}")==-1);
    assert(json("{\"type\":\"agent_state\",\"state\":\"listening\",\"state\":\"speaking\"}")==-1);
    unrecognized_audio_rearms_without_interrupting_thinking();
    puts("Legacy GitHub relay: greeting, PCM tail, playback gate, VAD retry, early reply and end passed");
    return 0;
}
