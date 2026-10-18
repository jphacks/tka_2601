#include "voice_transport.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned checks;
static TickType_t now;
static uint8_t input[16384], output[16384];
static size_t input_size, input_position, output_size, read_limit, write_limit;
static bool timeout_with_bytes, eof, local, nodelay;
static cy_rslt_t recv_error, send_error;
static uint32_t io_delay;
static unsigned deleted, options, random_calls;
static unsigned blocked_sends, partial_block;
static int protocol;
static void check(bool condition) { ++checks; assert(condition); }
TickType_t xTaskGetTickCount(void) { return now; }
void vTaskDelay(TickType_t ticks) { now+=ticks; }
cy_rslt_t cy_socket_delete(cy_socket_t socket) { check(socket==42); ++deleted; return 0; }
cy_rslt_t cy_socket_setsockopt(cy_socket_t socket,int level,int name,const void *value,uint32_t length)
{
    check(socket==42 && value && length);
    if (level==CY_SOCKET_SOL_TLS) options |= 1u << name;
    if (name==CY_SOCKET_SO_TCP_NODELAY) {
        check(level==CY_SOCKET_SOL_TCP && length==sizeof(uint8_t) && *(const uint8_t *)value==1);
        nodelay=true;
    }
    return 0;
}
cy_rslt_t cy_socket_send(cy_socket_t socket,const void *data,uint32_t length,int flags,uint32_t *sent)
{
    check(socket==42 && !flags && length); now+=io_delay;
    *sent=0; if (send_error) return send_error;
    if (blocked_sends) { --blocked_sends; return CY_RSLT_MODULE_SECURE_SOCKETS_WOULDBLOCK; }
    size_t n=length; if (n>write_limit) n=write_limit;
    check(n<=sizeof(output)-output_size);
    if (partial_block && n>partial_block) n=partial_block;
    memcpy(output+output_size,data,n); output_size+=n; *sent=(uint32_t)n;
    if (partial_block) { partial_block=0; return CY_RSLT_MODULE_SECURE_SOCKETS_WOULDBLOCK; }
    return 0;
}
cy_rslt_t cy_socket_recv(cy_socket_t socket,void *data,uint32_t length,int flags,uint32_t *received)
{
    check(socket==42 && !flags && length); now+=io_delay;
    size_t n=input_size-input_position;
    if (n>length) n=length;
    if (n>read_limit) n=read_limit;
    memcpy(data,input+input_position,n); input_position+=n; *received=(uint32_t)n;
    if (recv_error) return recv_error;
    if (!n && eof) return 0;
    return (!n && !eof) || timeout_with_bytes || n<length ? CY_RSLT_MODULE_SECURE_SOCKETS_TIMEOUT : 0;
}
cy_rslt_t cy_socket_gethostbyname(const char *host,int version,cy_socket_ip_address_t *address)
{ check(host && version==4); address->address=123; return 0; }
cy_rslt_t cy_socket_create(int domain,int type,int p,cy_socket_t *socket)
{ check(domain==2 && type==1); protocol=p; *socket=42; return 0; }
cy_rslt_t cy_socket_connect(cy_socket_t socket,const cy_socket_sockaddr_t *address,uint32_t length)
{ check(socket==42 && address->ip_address.address==123 && length==sizeof(*address)); return 0; }
bool m5_link_destination_is_local(void) { return local; }
void mbedtls_entropy_init(mbedtls_entropy_context *c) { c->initialized=1; }
void mbedtls_entropy_free(mbedtls_entropy_context *c) { c->initialized=0; }
int mbedtls_entropy_func(void *c,unsigned char *o,size_t n) { (void)c; memset(o,0,n); return 0; }
void mbedtls_ctr_drbg_init(mbedtls_ctr_drbg_context *c) { c->initialized=1; }
void mbedtls_ctr_drbg_free(mbedtls_ctr_drbg_context *c) { c->initialized=0; }
int mbedtls_ctr_drbg_seed(mbedtls_ctr_drbg_context *c,int (*entropy)(void *,unsigned char *,size_t),
                         void *source,const unsigned char *personal,size_t length)
{ check(c && entropy && source && personal && length); return 0; }
int mbedtls_ctr_drbg_random(void *c,unsigned char *output_bytes,size_t length)
{
    check(c!=NULL); ++random_calls;
    for (size_t i=0;i<length;++i) output_bytes[i]=(uint8_t)(i+1);
    return 0;
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
    read_limit=write_limit=16384; timeout_with_bytes=eof=nodelay=false; local=true;
    recv_error=send_error=0; io_delay=1; deleted=options=random_calls=0; protocol=0;
    blocked_sends=partial_block=0;
    voice_transport_init(link); link->socket=42; link->websocket=websocket; link->progress=now;
}
static void append(const void *data,size_t length)
{ check(length<=sizeof(input)-input_size); memcpy(input+input_size,data,length); input_size+=length; }
static size_t packet(uint8_t *wire,uint8_t type,uint32_t length)
{
    voice_header_t h={.type=type,.session=0x12345678,.turn=7,.sequence=3,.length=length};
    if (type!=VOICE_OUTPUT_AUDIO && type!=VOICE_PING) h.sequence=0;
    check(voice_header_encode(wire,&h));
    for (uint32_t i=0;i<length;++i) wire[VOICE_HEADER+i]=(uint8_t)i;
    return VOICE_HEADER+length;
}
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
static void tcp_partial_reads(void)
{
    voice_transport_t link; voice_packet_t got; uint8_t wire[VOICE_PACKET];
    reset(&link,false); size_t size=packet(wire,VOICE_OUTPUT_AUDIO,640); append(wire,size);
    read_limit=7; timeout_with_bytes=true;
    check(poll_until(&link,&got,200)==1);
    check(got.header.length==640 && got.header.sequence==3 && got.header.turn==7);
    check(!memcmp(got.payload,wire+VOICE_HEADER,640));
    check(link.message_used==0 && input_position==size);
    check(voice_transport_poll(&link,&got)==0); // idle timeout is not EOF
    eof=true; check(voice_transport_poll(&link,&got)==-1);
    voice_transport_close(&link); check(deleted==1 && link.socket==CY_SOCKET_INVALID_HANDLE);
    reset(&link,false); append(wire,10); check(voice_transport_poll(&link,&got)==0);
    now+=5001; check(voice_transport_poll(&link,&got)==-1); // partial packet expires
    reset(&link,false); append(wire,24); wire[20]=0; wire[21]=0; wire[22]=6; wire[23]=0;
    memcpy(input,wire,24); check(voice_transport_poll(&link,&got)==-1); // oversized
    reset(&link,false); recv_error=99; append(wire,5); check(voice_transport_poll(&link,&got)==-1);
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
    read_limit=3; timeout_with_bytes=true;
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
    reset(&link,false); write_limit=1; io_delay=100;
    check(!voice_transport_send(&link,&h,pcm)); check(now<=2300 && output_size<664);
    reset(&link,false); write_limit=0; check(!voice_transport_send(&link,&h,pcm));
    reset(&link,false); blocked_sends=25; partial_block=13;
    check(voice_transport_send(&link,&h,pcm));
    check(output_size==VOICE_HEADER+sizeof(pcm));
    check(!memcmp(output+VOICE_HEADER,pcm,sizeof(pcm))); /* no duplicated partial bytes */
    reset(&link,false); send_error=CY_RSLT_MODULE_SECURE_SOCKETS_WOULDBLOCK;
    check(!voice_transport_send(&link,&h,pcm)); check(now<=2300 && output_size==0);
    reset(&link,false); recv_error=CY_RSLT_MODULE_SECURE_SOCKETS_WOULDBLOCK;
    voice_packet_t pending; check(voice_transport_poll(&link,&pending)==0);
    reset(&link,true); check(!voice_transport_send(&link,&h,NULL));
    h.length=641; check(!voice_transport_send(&link,&h,pcm));
}
static void upgrade_and_connections(void)
{
    voice_transport_t link; voice_packet_t got;
    reset(&link,false); local=false; check(!voice_transport_m5(&link));
    reset(&link,false); check(voice_transport_m5(&link) && protocol==CY_SOCKET_IPPROTO_TCP);
    check(nodelay);
    const char response[]="HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
      "Connection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
    reset(&link,false); append(response,strlen(response));
    const char ready[]="{\"type\":\"ready\",\"protocol_version\":2}";
    websocket(1,true,(const uint8_t *)ready,strlen(ready));
    timeout_with_bytes=true;
    check(voice_transport_server(&link));
    check(nodelay);
    check(protocol==CY_SOCKET_IPPROTO_TLS && link.websocket && link.random_ready);
    check((options & (1u << CY_SOCKET_SO_TLS_AUTH_MODE))!=0);
    check((options & (1u << CY_SOCKET_SO_TRUSTED_ROOTCA_CERTIFICATE))!=0);
    check((options & (1u << CY_SOCKET_SO_SERVER_NAME_INDICATION))!=0);
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
    check(strstr(decoded,"\"device_key\":\"e84-diagnostic-unpaired\"")!=NULL);
#else
    check(strstr(decoded,"\"device_key\":\"test-device-key\"")!=NULL);
#endif
    check(strstr(decoded,"\"visit_id\":\"01020304-0506-4708-890a-0b0c0d0e0f10\"")!=NULL);
    check(poll_until(&link,&got,10)==1 && got.header.type==VOICE_READY);
    reset(&link,false); link.diagnostic=true;
    append(response,strlen(response)); check(voice_transport_server(&link)); output_size=0;
    check(voice_transport_send(&link,&hello,NULL));
    prefix=(output[1]&127)==126?4:2; length=output_size-prefix-4;
    for(size_t i=0;i<length;++i) decoded[i]=(char)(output[prefix+4+i]^output[prefix+i%4]);
    decoded[length]=0;
    check(strstr(decoded,"\"device_key\":\"e84-diagnostic-unpaired\"")!=NULL);
    reset(&link,false); const char denied[]="HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";
    append(denied,strlen(denied)); check(!voice_transport_server(&link));
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
    tcp_partial_reads(); ws_fragmentation_and_ping(); sends_are_bounded(); upgrade_and_connections();
    legacy_silence_keeps_vad_clock();
    printf("E84 voice transport: %u checks passed\n",checks); return 0;
}
