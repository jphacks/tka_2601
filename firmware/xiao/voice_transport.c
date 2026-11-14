#include "voice_transport.h"
#include "voice_settings.h"
#include "api_settings.h"
#include "device_mode.h"
#include "door_root_ca.h"
#include "xlog.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha1.h"
#include <stdio.h>
#include <string.h>

#define UNPAIRED_DEVICE_KEY "xiao-diagnostic-unpaired"

void voice_transport_init(voice_transport_t *l)
{
    memset(l,0,sizeof(*l));
    l->relay.allow_legacy=VOICE_RELAY_PROTOCOL==1;
}
bool voice_transport_legacy(const voice_transport_t *l) { return l->websocket && l->relay.legacy; }
static const char *device_key(const voice_transport_t *link)
{
    // Same diagnostic fallback for both relay versions. The API bearer key
    // still authenticates the connection. An unpaired ID cannot load resident
    // settings or save history as a registered household device.
    if (link->diagnostic) return UNPAIRED_DEVICE_KEY;
    return DOOR_DEVICE_KEY[0] ? DOOR_DEVICE_KEY : UNPAIRED_DEVICE_KEY;
}
void voice_transport_close(voice_transport_t *l)
{
    if (l->socket) net_stream_close(l->socket);
    voice_transport_init(l);
}
typedef enum {
    RECEIVE_FAILED = -1,
    RECEIVE_PENDING = 0,
    RECEIVE_COMPLETE = 1
} receive_result_t;

static bool send_all(voice_transport_t *l, const uint8_t *p, size_t n)
{
    uint32_t start=net_now_ms();
    while (n) {
        if (net_now_ms()-start>2000u) {
            xlog("[VOICE] Server send stalled for 2 seconds.\n");
            return false;
        }
        int sent=net_stream_write(l->socket,p,n);
        if (sent<0 || (size_t)sent>n) {
            xlog("[VOICE] Server send failed: remaining=%lu.\n",(unsigned long)n);
            return false;
        }
        if (!sent) { net_sleep_ms(1); continue; } /* bounded backpressure, not a disconnect */
        p+=sent; n-=(size_t)sent;
    }
    return true;
}
static receive_result_t receive(voice_transport_t *l, uint8_t *p, size_t wanted, size_t *used)
{
    int n=net_stream_read(l->socket,p+*used,wanted-*used);
    if (n<0) {
        xlog("[VOICE] Server socket closed or receive failed.\n");
        return RECEIVE_FAILED;
    }
    if ((size_t)n>wanted-*used) return RECEIVE_FAILED;
    *used+=(size_t)n;
    if (n) l->progress=net_now_ms();
    return *used==wanted ? RECEIVE_COMPLETE : RECEIVE_PENDING;
}
bool voice_transport_configured(void)
{
    if (!DOOR_API_HOST[0] || strlen(DOOR_API_HOST)>127 || strlen(DOOR_API_KEY)<32 || strlen(DOOR_API_KEY)>511) return false;
    for (const char *p=DOOR_API_KEY;*p;++p) if ((unsigned char)*p<33 || (unsigned char)*p>126) return false;
    for (const char *p=DOOR_API_HOST;*p;++p)
        if (!((*p>='a'&&*p<='z') || (*p>='A'&&*p<='Z') || (*p>='0'&&*p<='9') || *p=='-' || *p=='.')) return false;
    return true;
}
bool voice_transport_server(voice_transport_t *l)
{
    if (!voice_relay_settings_valid(device_mode_relay_name(),device_key(l))) {
        xlog("[VOICE] Relay settings missing/invalid: set DOOR_DEVICE_KEY in .env (mode comes from the app, DOOR_RELAY_MODE is only the default), run python3 configure_api.py, then rebuild.\n");
        return false;
    }
    if (l->diagnostic || !DOOR_DEVICE_KEY[0])
        xlog("[VOICE] Unpaired diagnostic session; resident settings/history unavailable.\n");
    if (!voice_transport_configured()) return false;
    l->socket=net_stream_open(DOOR_API_HOST,443,DOOR_ROOT_CA_PEM);
    if (!l->socket) {
        xlog("[VOICE] TLS connection failed.\n");
        return false;
    }
    uint8_t nonce[16], digest[20]; unsigned char key[32], expected[32]; size_t n;
    net_random(nonce,sizeof(nonce));
    if (mbedtls_base64_encode(key,sizeof(key),&n,nonce,sizeof(nonce))) return false;
    key[n]=0;
    char challenge[64];
    int c=snprintf(challenge,sizeof(challenge),"%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",key);
    if (c<=0 || (size_t)c>=sizeof(challenge) || mbedtls_sha1((const unsigned char *)challenge,(size_t)c,digest) ||
        mbedtls_base64_encode(expected,sizeof(expected),&n,digest,sizeof(digest))) return false;
    expected[n]=0;
    char request[1024];
    c=snprintf(request,sizeof(request),"GET %s HTTP/1.1\r\nHost: %s\r\n"
        "Authorization: Bearer %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n",
        VOICE_STREAM_PATH,DOOR_API_HOST,DOOR_API_KEY,key);
    if (c<=0 || (size_t)c>=sizeof(request) || !send_all(l,(uint8_t *)request,(size_t)c)) return false;
    memset(request,0,sizeof(request));
    /* Read only through the HTTP terminator, retaining the first WS frame in TLS. */
    char response[2048]; size_t used=0;
    uint32_t start=net_now_ms();
    while (used<sizeof(response)-1 && net_now_ms()-start<15000u) {
        size_t one=0;
        receive_result_t r=receive(l,(uint8_t *)response+used,1,&one);
        used+=one;
        if (r==RECEIVE_FAILED) return false;
        if (used>=4 && !memcmp(response+used-4,"\r\n\r\n",4)) break;
        if (!one) net_sleep_ms(1);
    }
    response[used]=0;
    if (!voice_ws_upgrade_valid(response,(char *)expected)) {
        /* Do not print arbitrary server content or echoed Authorization. */
        xlog("[VOICE] WebSocket upgrade rejected. Check /api/relay authentication and proxy Upgrade forwarding.\n");
        return false;
    }
    l->websocket=true;
    l->progress=net_now_ms();
    return true;
}
static bool websocket_send(voice_transport_t *l, uint8_t op, const uint8_t *p, size_t n)
{
    uint8_t frame[VOICE_PACKET+8], mask[4];
    if (n>VOICE_PACKET) return false;
    net_random(mask,4);
    size_t h=2; frame[0]=0x80|op;
    if (n<126) frame[1]=0x80|(uint8_t)n;
    else { frame[1]=0xfe; frame[2]=(uint8_t)(n>>8); frame[3]=(uint8_t)n; h=4; }
    memcpy(frame+h,mask,4); h+=4;
    for (size_t i=0;i<n;++i) frame[h+i]=p[i]^mask[i%4];
    return send_all(l,frame,h+n);
}
bool voice_transport_send(voice_transport_t *l, const voice_header_t *h, const void *payload)
{
    if (!l->socket || !l->websocket) return false;
    uint8_t wire[VOICE_PACKET];
    char uuid[37]={0};
    if (h->type==VOICE_HELLO) {
        uint8_t random[16];
        net_random(random,sizeof(random));
        random[6]=(random[6]&15)|0x40; random[8]=(random[8]&63)|0x80;
        (void)snprintf(uuid,sizeof(uuid),"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            random[0],random[1],random[2],random[3],random[4],random[5],random[6],random[7],
            random[8],random[9],random[10],random[11],random[12],random[13],random[14],random[15]);
    }
    size_t length; uint8_t opcode;
    if (!voice_relay_encode(&l->relay,h,payload,uuid,device_mode_relay_name(),
            device_key(l),
            wire,sizeof(wire),&length,&opcode)) return false;
    bool sent=!length || websocket_send(l,opcode,wire,length);
    memset(wire,0,sizeof(wire)); /* start contains the private device key */
    return sent;
}
int voice_transport_poll(voice_transport_t *l, voice_packet_t *p)
{
    if (!l->socket || !l->websocket) return -1;
    uint32_t now=net_now_ms();
    if ((l->header_used || l->message_used || l->frame_used || l->fragmented) && now-l->progress>5000u) {
        xlog("[VOICE] Server partial receive stalled for 5 seconds.\n");
        return -1;
    }
    l->relay.clock_ms=now;
    int pending=voice_relay_pending(&l->relay,l->relay.clock_ms,&p->header,p->payload);
    if (pending) return pending;
    // The existing relay feeds a live audio track, so silence must keep time
    // while the local VAD waits and after a 30s cutoff. Without these frames,
    // the server VAD cannot observe the end of a max-duration utterance.
    if (l->relay.legacy && l->relay.call_started &&
        (l->relay.input_active || l->relay.waiting_reply) &&
        !l->relay.output_active && !l->relay.output_complete && !l->relay.speaking &&
        l->relay.clock_ms-l->relay.last_input_ms>=20u) {
        const uint8_t silence[640]={0};
        if (!websocket_send(l,2,silence,sizeof(silence))) return -1;
        l->relay.last_input_ms=l->relay.clock_ms;
    }
    if (l->header_used<2) {
        receive_result_t r=receive(l,l->frame_header,2,&l->header_used);
        if (r!=RECEIVE_COMPLETE) {
            if (r==RECEIVE_PENDING && !l->header_used && !l->fragmented)
                return voice_relay_pending(&l->relay,l->relay.clock_ms,&p->header,p->payload);
            return r;
        }
    }
    if ((l->frame_header[1]&127)==126 && l->header_used<4) {
        receive_result_t r=receive(l,l->frame_header,4,&l->header_used); if (r!=RECEIVE_COMPLETE) return r;
    }
    if (voice_ws_header(l->frame_header,l->header_used,&l->opcode,&l->final,&l->frame_length)<=0) return -1;
    if (l->frame_used<l->frame_length) {
        receive_result_t r=receive(l,l->frame,l->frame_length,&l->frame_used); if (r!=RECEIVE_COMPLETE) return r;
    }
    l->header_used=l->frame_used=0;
    if (l->opcode==8) { (void)websocket_send(l,8,l->frame,l->frame_length); return -1; }
    if (l->opcode==9) return websocket_send(l,10,l->frame,l->frame_length)?0:-1;
    if (l->opcode==10) return 0;
    if ((l->opcode==0 && !l->fragmented) || (l->opcode!=0 && l->fragmented) ||
        l->frame_length>sizeof(l->message)-l->message_used) return -1;
    if (l->opcode!=0) l->message_opcode=l->opcode;
    memcpy(l->message+l->message_used,l->frame,l->frame_length); l->message_used+=l->frame_length;
    l->fragmented=!l->final;
    if (!l->final) return 0;
    int result=voice_relay_decode(&l->relay,l->message_opcode,l->message,l->message_used,&p->header,p->payload);
    l->message_used=0;
    if (result<0) xlog("[VOICE] Invalid/incompatible /api/relay message.\n");
    return result;
}
