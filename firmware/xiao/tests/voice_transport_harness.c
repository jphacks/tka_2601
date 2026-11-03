#include "voice_transport.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned checks;
static uint32_t now;
static uint8_t input[16384], output[16384];
static size_t input_size, input_position, output_size, read_limit, write_limit;
static bool eof, read_error, write_error;
static uint32_t io_delay;
static unsigned closed, opened, blocked_sends, random_calls;
static const char *opened_ca, *opened_host;
static net_stream_t *const fake_stream=(net_stream_t *)0x1234;
static void check(bool condition) { ++checks; assert(condition); }
uint32_t net_now_ms(void) { return now; }
void net_sleep_ms(uint32_t ms) { now+=ms; }
void net_random(void *out,size_t length)
{
    ++random_calls;
    for (size_t i=0;i<length;++i) ((uint8_t *)out)[i]=(uint8_t)(i+1);
}
net_stream_t *net_stream_open(const char *host,uint16_t port,const char *ca)
{ check(host && port==443 && ca); ++opened; opened_ca=ca; opened_host=host; return fake_stream; }
void net_stream_close(net_stream_t *s) { check(s==fake_stream); ++closed; }
int net_stream_write(net_stream_t *s,const void *data,size_t length)
{
    check(s==fake_stream && length); now+=io_delay;
    if (write_error) return -1;
    if (blocked_sends) { --blocked_sends; return 0; }
    size_t n=length; if (n>write_limit) n=write_limit;
    check(n<=sizeof(output)-output_size);
    memcpy(output+output_size,data,n); output_size+=n;
    return (int)n;
}
int net_stream_read(net_stream_t *s,void *data,size_t length)
{
    check(s==fake_stream && length); now+=io_delay;
    if (read_error) return -1;
    size_t n=input_size-input_position;
    if (n>length) n=length;
    if (n>read_limit) n=read_limit;
    memcpy(data,input+input_position,n); input_position+=n;
    if (!n && eof) return -1;
    return (int)n;
}
/* Crypto primitives are stubs; only transport upgrade validation is exercised. */
int mbedtls_base64_encode(unsigned char *out,size_t capacity,size_t *written,const unsigned char *in,size_t length)
{
    const char *value=length==16?"dGhlIHNhbXBsZSBub25jZQ==":"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
    check(in && capacity>strlen(value)); *written=strlen(value); memcpy(out,value,*written); return 0;
}
int mbedtls_sha1(const unsigned char *in,size_t n,unsigned char out[20])
{ check(in && n); memset(out,0,20); return 0; }

static void reset(voice_transport_t *link,bool websocket)
{
    now=100; input_size=input_position=output_size=0;
    read_limit=write_limit=16384; eof=read_error=write_error=false;
    io_delay=1; closed=opened=blocked_sends=random_calls=0;
    voice_transport_init(link); link->socket=fake_stream; link->websocket=websocket; link->progress=now;
}
static void append(const void *data,size_t length)
{ check(length<=sizeof(input)-input_size); memcpy(input+input_size,data,length); input_size+=length; }
static void websocket(uint8_t opcode,bool final,const uint8_t *bytes,size_t length)
{
    uint8_t header[4]={(uint8_t)(opcode|(final?0x80:0)),0,0,0}; size_t used=2;
    if (length<126) header[1]=(uint8_t)length;
    else { header[1]=126; header[2]=(uint8_t)(length>>8); header[3]=(uint8_t)length; used=4; }
    append(header,used); if(length) append(bytes,length);
}
static int poll_until(voice_transport_t *link,voice_packet_t *result,unsigned limit)
{
    int status=0;
    while (limit-- && status==0) status=voice_transport_poll(link,result);
    return status;
}
static void ws_fragmentation_and_ping(void)
{
    voice_transport_t link; voice_packet_t got; uint8_t wire[VOICE_PACKET];
    reset(&link,true);
    link.relay=(voice_relay_t){.started=true,.ready=true,.session=1,.output_active=true,.output_turn=7};
    size_t size=640; memset(wire,0x45,size);
    websocket(2,false,wire,13);
    const uint8_t ping[]={4,5,6}; websocket(9,true,ping,sizeof(ping));
    websocket(0,true,wire+13,size-13);
    read_limit=3;
    check(poll_until(&link,&got,300)==1);
    check(got.header.length==640 && got.header.turn==7 && got.header.sequence==0 && !memcmp(got.payload,wire,640));
    check(!link.fragmented && link.message_used==0);
    check(output_size==9 && output[0]==0x8a && output[1]==0x83);
    for(size_t i=0;i<3;++i) check((output[6+i]^output[2+i%4])==ping[i]);
    // Coalesced text controls stay distinct and retain the fragmented text opcode.
    reset(&link,true); link.relay=(voice_relay_t){.started=true,.session=1};
    const char ready[]="{\"type\":\"ready\",\"protocol_version\":2}";
    const char pong[]="{\"type\":\"pong\",\"turn_id\":0,\"seq\":1}";
    websocket(1,false,(const uint8_t *)ready,5);
    websocket(0,true,(const uint8_t *)ready+5,strlen(ready)-5);
    websocket(1,true,(const uint8_t *)pong,strlen(pong));
    check(voice_transport_poll(&link,&got)==0);
    check(voice_transport_poll(&link,&got)==1 && got.header.type==VOICE_READY);
    check(voice_transport_poll(&link,&got)==1 && got.header.type==VOICE_PONG);
    reset(&link,true); websocket(0,true,wire,size);
    check(voice_transport_poll(&link,&got)==-1); // unexpected continuation
    reset(&link,true); websocket(2,false,wire,size); websocket(2,true,wire,size);
    check(voice_transport_poll(&link,&got)==0); check(voice_transport_poll(&link,&got)==-1);
    reset(&link,true); memset(wire,0,sizeof(wire));
    websocket(2,false,wire,700); websocket(0,true,wire,700);
    check(voice_transport_poll(&link,&got)==0); check(voice_transport_poll(&link,&got)==-1);
    reset(&link,true); const uint8_t masked[]={0x82,0x80}; append(masked,2);
    check(voice_transport_poll(&link,&got)==-1);
    reset(&link,true); websocket(8,true,NULL,0);
    check(voice_transport_poll(&link,&got)==-1 && output[0]==0x88);
    reset(&link,true); append("\x82",1);
    check(voice_transport_poll(&link,&got)==0);
    now+=5001; check(voice_transport_poll(&link,&got)==-1);
}
static void sends_are_bounded(void)
{
    voice_transport_t link;
    voice_header_t h={.type=VOICE_INPUT_AUDIO,.session=1,.turn=1,.sequence=0,.length=640};
    uint8_t pcm[640]; memset(pcm,0x5a,sizeof(pcm));
    reset(&link,true); write_limit=7;
    link.relay=(voice_relay_t){.started=true,.ready=true,.session=1,.input_active=true,.input_turn=1};
    check(voice_transport_send(&link,&h,pcm));
    check(output_size==648 && output[0]==0x82 && output[1]==0xfe && output[2]==2 && output[3]==128);
    uint8_t decoded[640];
    for(size_t i=0;i<sizeof(decoded);++i) decoded[i]=output[8+i]^output[4+i%4];
    check(!memcmp(decoded,pcm,640));
    /* Temporary backpressure retries without duplicating bytes. */
    reset(&link,true); blocked_sends=25; write_limit=13;
    link.relay=(voice_relay_t){.started=true,.ready=true,.session=1,.input_active=true,.input_turn=1};
    check(voice_transport_send(&link,&h,pcm));
    check(output_size==648);
    /* A send that makes no progress gives up at about two seconds. */
    reset(&link,true); write_limit=0;
    link.relay=(voice_relay_t){.started=true,.ready=true,.session=1,.input_active=true,.input_turn=1};
    check(!voice_transport_send(&link,&h,pcm)); check(now<=2300 && output_size==0);
    reset(&link,true); write_error=true;
    link.relay=(voice_relay_t){.started=true,.ready=true,.session=1,.input_active=true,.input_turn=1};
    check(!voice_transport_send(&link,&h,pcm));
    /* Invalid frames never reach the socket. */
    reset(&link,true); check(!voice_transport_send(&link,&h,NULL));
    h.length=641; check(!voice_transport_send(&link,&h,pcm)); check(output_size==0);
    /* Nothing can be sent or received without an open connection. */
    voice_transport_init(&link); voice_packet_t got;
    h.length=640; check(!voice_transport_send(&link,&h,pcm));
    check(voice_transport_poll(&link,&got)==-1);
}
static void read_results(void)
{
    voice_transport_t link; voice_packet_t got;
    reset(&link,true); link.relay=(voice_relay_t){.started=true,.session=1};
    check(voice_transport_poll(&link,&got)==0); /* idle is not EOF */
    eof=true; check(voice_transport_poll(&link,&got)==-1);
    reset(&link,true); link.relay=(voice_relay_t){.started=true,.session=1};
    read_error=true; check(voice_transport_poll(&link,&got)==-1);
    voice_transport_close(&link); check(closed==1 && link.socket==NULL);
}
static void upgrade_and_connections(void)
{
    voice_transport_t link; voice_packet_t got;
    const char response[]="HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
      "Connection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
    reset(&link,false); link.socket=NULL; append(response,strlen(response));
    const char ready[]="{\"type\":\"ready\",\"protocol_version\":2}";
    websocket(1,true,(const uint8_t *)ready,strlen(ready));
    check(voice_transport_server(&link));
    check(opened==1 && link.websocket && !strcmp(opened_host,"example.test"));
    check(input_position==strlen(response)); // upgrade never consumes first WS frame
    check(output_size<sizeof(output)); output[output_size]=0;
    check(strstr((char *)output,"GET /api/relay HTTP/1.1\r\n")!=NULL);
    check(strstr((char *)output,"Authorization: Bearer test-only-")!=NULL);
    output_size=0;
    voice_header_t hello={.type=VOICE_HELLO,.session=1};
    check(voice_transport_send(&link,&hello,NULL));
    check(output[0]==0x81 && (output[1]&0x80));
    size_t prefix=(output[1]&127)==126?4:2;
    size_t length=output_size-prefix-4;
    char decoded[VOICE_PACKET];
    for(size_t i=0;i<length;++i) decoded[i]=(char)(output[prefix+4+i]^output[prefix+i%4]);
    decoded[length]=0;
    check(strstr(decoded,"\"protocol_version\":2")!=NULL);
#ifdef TEST_UNPAIRED
    check(strstr(decoded,"\"device_key\":\"xiao-diagnostic-unpaired\"")!=NULL);
#else
    check(strstr(decoded,"\"device_key\":\"test-device-key\"")!=NULL);
#endif
    check(strstr(decoded,"\"visit_id\":\"01020304-0506-4708-890a-0b0c0d0e0f10\"")!=NULL);
    check(poll_until(&link,&got,10)==1 && got.header.type==VOICE_READY);
    reset(&link,false); link.socket=NULL; link.diagnostic=true;
    append(response,strlen(response)); check(voice_transport_server(&link)); output_size=0;
    check(voice_transport_send(&link,&hello,NULL));
    prefix=(output[1]&127)==126?4:2; length=output_size-prefix-4;
    for(size_t i=0;i<length;++i) decoded[i]=(char)(output[prefix+4+i]^output[prefix+i%4]);
    decoded[length]=0;
    check(strstr(decoded,"\"device_key\":\"xiao-diagnostic-unpaired\"")!=NULL);
    reset(&link,false); link.socket=NULL; const char denied[]="HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";
    append(denied,strlen(denied)); check(!voice_transport_server(&link));
    /* A silent server fails the upgrade instead of hanging. */
    reset(&link,false); link.socket=NULL; check(!voice_transport_server(&link));
}
static void legacy_silence_keeps_vad_clock(void)
{
    voice_transport_t link; voice_packet_t got;
    reset(&link,true); io_delay=0;
    link.relay=(voice_relay_t){.started=true,.ready=true,.legacy=true,.call_started=true,
        .session=1,.input_active=true,.input_turn=1};
    check(voice_transport_poll(&link,&got)==0 && output_size==648);
    for(size_t i=0;i<640;++i) check((output[8+i]^output[4+i%4])==0);
    now+=19; check(voice_transport_poll(&link,&got)==0 && output_size==648);
    now+=1; check(voice_transport_poll(&link,&got)==0 && output_size==1296);
    link.relay.output_active=true;
    now+=20; check(voice_transport_poll(&link,&got)==0 && output_size==1296);
    link.relay.output_active=false; link.relay.input_active=false; link.relay.waiting_reply=true;
    check(voice_transport_poll(&link,&got)==0 && output_size==1944);
    link.relay.speaking=true; now+=20;
    check(voice_transport_poll(&link,&got)==0 && output_size==1944);
}
int main(void)
{
    ws_fragmentation_and_ping(); sends_are_bounded(); read_results(); upgrade_and_connections();
    legacy_silence_keeps_vad_clock();
    printf("voice transport: %u checks passed\n",checks); return 0;
}
