#include "relay_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned checks;
static void check(bool ok) { ++checks; assert(ok); }
static const char uuid[]="01020304-0506-4708-890a-0b0c0d0e0f10";
static voice_relay_t relay;
static uint8_t wire[VOICE_PACKET], payload[VOICE_PAYLOAD], opcode;
static size_t length;
static voice_header_t header;
static bool send(uint8_t type, uint32_t turn, uint32_t sequence, uint8_t flags, uint32_t n)
{
    voice_header_t h={.session=123,.type=type,.turn=turn,.sequence=sequence,.flags=flags,.length=n};
    return voice_relay_encode(&relay,&h,payload,uuid,"omakase","sample-device-key",wire,sizeof(wire),&length,&opcode);
}
static int json(const char *text)
{ return voice_relay_decode(&relay,1,(const uint8_t *)text,strlen(text),&header,payload); }
static void start(void)
{
    memset(&relay,0,sizeof(relay));
    check(send(VOICE_HELLO,0,0,0,0));
    check(opcode==1 && length<sizeof(wire));
    check(strstr((char *)wire,"\"protocol_version\":2")!=NULL);
    check(strstr((char *)wire,"\"visit_id\":\"01020304-0506-4708-890a-0b0c0d0e0f10\"")!=NULL);
    check(json("{\"type\":\"ready\",\"protocol_version\":2}")==1 && header.type==VOICE_READY && header.session==123);
}
static void output(void)
{
    check(json("{\"type\":\"output_start\",\"turn_id\":1,\"output_id\":1}")==1);
    check(header.type==VOICE_OUTPUT_START);
    memset(wire,0x55,640);
    check(voice_relay_decode(&relay,2,wire,640,&header,payload)==1);
    check(header.sequence==0 && header.length==640 && header.turn==1 && header.type==VOICE_OUTPUT_AUDIO);
    check(!memcmp(payload,wire,640));
    check(send(VOICE_AUDIO_ACK,1,1,0,0));
    check(strstr((char *)wire,"\"frames\":1")!=NULL);
    check(!send(VOICE_PLAYBACK_DONE,1,1,0,0));
    check(voice_relay_decode(&relay,2,wire,240,&header,payload)==1);
    check(header.sequence==1 && header.length==240);
    check(json("{\"type\":\"output_end\",\"turn_id\":1,\"output_id\":1,\"frames\":2,\"samples\":440,\"end_call\":false}")==1);
    check(header.type==VOICE_OUTPUT_END && header.sequence==2 && !header.flags);
    check(send(VOICE_PLAYBACK_DONE,1,2,0,0));
    check(strstr((char *)wire,"\"samples\":440")!=NULL);
    check(!send(VOICE_PLAYBACK_DONE,1,1,0,0));
    check(voice_relay_decode(&relay,2,wire,640,&header,payload)==-1);
}
static void full_cycle(void)
{
    start(); check(send(VOICE_CALL_START,0,0,0,0));
    check(strstr((char *)wire,"call_started")!=NULL);
    check(json("{\"type\":\"listen\",\"turn_id\":1}")==1 && header.type==VOICE_LISTEN);
    check(send(VOICE_INPUT_START,1,0,0,0));
    check(!send(VOICE_INPUT_START,1,0,0,0));
    check(!send(VOICE_INPUT_AUDIO,1,1,0,640));
    memset(payload,0x4c,640);
    check(send(VOICE_INPUT_AUDIO,1,0,0,640));
    check(opcode==2 && length==640 && wire[0]==0x4c && wire[639]==0x4c);
    check(!send(VOICE_INPUT_END,1,2,0,0));
    check(!send(VOICE_INPUT_END,1,1,1,0));
    check(send(VOICE_INPUT_END,1,1,0,0));
    check(strstr((char *)wire,"\"reason\":\"silence\"")!=NULL);
    output();
    check(json("{\"type\":\"listen\",\"turn_id\":2}")==1);
    check(send(VOICE_INPUT_START,2,0,0,0));
    for(unsigned i=0;i<1500;++i) check(send(VOICE_INPUT_AUDIO,2,i,0,640));
    check(!send(VOICE_INPUT_AUDIO,2,1500,0,640));
    check(send(VOICE_INPUT_END,2,1500,1,0));
    check(strstr((char *)wire,"\"samples\":480000")!=NULL && strstr((char *)wire,"max_duration")!=NULL);
    check(json("{\"type\":\"no_reply\",\"turn_id\":2}")==1 && header.type==VOICE_NO_REPLY);
    check(json("{\"type\":\"call_end\",\"turn_id\":2,\"reason\":\"limit\"}")==1 && header.type==VOICE_CALL_END);
    check(send(VOICE_CALL_ENDED,2,0,0,0));
}
static void malformed(void)
{
    const char *bad[]={
        "{}", "[]", "null", "{\"type\":\"ready\"}",
        "{\"type\":\"ready\",\"protocol_version\":1}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"protocol_version\":2}",
        "{\"type\":\"ready\",\"protocol_version\":true}",
        "{\"type\":\"ready\",\"protocol_version\":2.0}",
        "{\"type\":\"ready\",\"protocol_version\":2e0}",
        "{\"type\":\"ready\",\"protocol_version\":02}",
        "{\"type\":\"ready\",\"protocol_version\":4294967296}",
        "{\"type\":\"ready\",\"protocol_version\":-2}",
        "{\"type\":\"ready\",\"protocol_version\":2} trailing",
        "{\"type\":\"ready\",\"protocol_version\":2,}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"extra\": [[[[[[[]]]]]]]}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"extra\":\"\\x41\"}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"extra\":\"\\uD800\"}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"extra\":\"\\uDC00\"}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"extra\":\"\xc0\x80\"}",
        "{\"type\":\"ready\",\"protocol_version\":2,\"extra\":\"\xf4\x90\x80\x80\"}",
    };
    for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);++i) {
        memset(&relay,0,sizeof(relay)); check(send(VOICE_HELLO,0,0,0,0)); check(json(bad[i])==-1);
    }
    start();
    check(json("{\"type\":\"ready\",\"protocol_version\":2}")==-1);
    check(json("{\"type\":\"output_start\",\"turn_id\":1,\"output_id\":2}")==-1);
    check(voice_relay_decode(&relay,2,wire,640,&header,payload)==-1);
    check(json("{\"type\":\"output_start\",\"turn_id\":1,\"output_id\":1}")==1);
    check(json("{\"type\":\"output_start\",\"turn_id\":1,\"output_id\":1}")==-1);
    check(voice_relay_decode(&relay,2,wire,0,&header,payload)==-1);
    check(voice_relay_decode(&relay,2,wire,641,&header,payload)==-1);
    check(voice_relay_decode(&relay,2,wire,642,&header,payload)==-1);
    check(voice_relay_decode(&relay,2,wire,640,&header,payload)==1);
    check(json("{\"type\":\"output_end\",\"turn_id\":1,\"output_id\":1,\"frames\":1,\"samples\":321,\"end_call\":false}")==-1);
    check(json("{\"type\":\"output_end\",\"turn_id\":1,\"output_id\":1,\"frames\":2,\"samples\":320,\"end_call\":false}")==-1);
    check(json("{\"type\":\"output_end\",\"turn_id\":1,\"output_id\":1,\"frames\":1,\"samples\":320,\"end_call\":true}")==1);
    check(header.flags==1);
    check(json("{\"type\":\"pong\",\"turn_id\":1}")==-1);
    check(json("{\"type\":\"surprise\",\"turn_id\":1}")==-1);
}
static void informational_and_bounds(void)
{
    start();
    check(json("{\"type\":\"transcript\",\"speaker\":\"ai\",\"text\":\"はい、どちら様でしょうか。\",\"extra\":[1,true,null,{\"a\":-2.5e+3}]}")==0);
    check(json("{\"type\":\"agent_state\",\"state\":\"listening\"}")==0);
    check(json("{\"type\":\"agent_state\",\"state\":\"\\uD83D\\uDE00\"}")==0);
    check(json("{\"t\\u0079pe\":\"ping\",\"turn_id\":1,\"seq\":42}")==1 && header.type==VOICE_PING && header.sequence==42);
    check(send(VOICE_PONG,1,42,0,0));
    check(json("{\"type\":\"error\",\"code\":\"test\",\"message\":\"Do not print server contents\"}")==1 && header.type==VOICE_ERROR && !header.length);
    check(voice_relay_decode(&relay,1,wire,VOICE_PACKET+1,&header,payload)==-1);
    const char good[]="{\"type\":\"pong\",\"turn_id\":1,\"seq\":42}";
    for(size_t i=0;i<strlen(good);++i) {
        check(voice_relay_decode(&relay,1,(const uint8_t *)good,i,&header,payload)==-1);
        for(unsigned b=0;b<256;++b) {
            memcpy(wire,good,sizeof(good)); wire[i]=(uint8_t)b;
            (void)voice_relay_decode(&relay,1,wire,strlen(good),&header,payload);
        }
    }
    check(voice_relay_settings_valid("normal","sample"));
    check(voice_relay_settings_valid("away","sample\"\\"));
    check(!voice_relay_settings_valid("unexpected","sample"));
    check(!voice_relay_settings_valid("omakase",""));
    check(!voice_relay_settings_valid("omakase","a b"));
    check(!voice_relay_settings_valid("omakase","a\nb"));
    check(!voice_relay_settings_valid("omakase","日本語"));
    char key[514]; memset(key,'"',512); key[512]=0;
    memset(&relay,0,sizeof(relay));
    voice_header_t hello={.type=VOICE_HELLO,.session=123};
    check(voice_relay_encode(&relay,&hello,NULL,uuid,"omakase",key,wire,sizeof(wire),&length,&opcode));
    check(length<VOICE_PACKET && strstr((char *)wire,"\\\"")!=NULL);
    key[512]='x'; key[513]=0; check(!voice_relay_settings_valid("omakase",key));
}
int main(void)
{
    full_cycle(); malformed(); informational_and_bounds();
    printf("relay v2 protocol: %u checks passed\n",checks); return 0;
}
