#include "voice_transport.h"
#include "voice_settings.h"
#include "api_settings.h"
#include "m5_settings.h"
#include "m5_link.h"
#include "door_root_ca.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha1.h"
#include <stdio.h>
#include <string.h>

void voice_transport_init(voice_transport_t *l)
{
    memset(l,0,sizeof(*l)); l->socket=CY_SOCKET_INVALID_HANDLE;
    l->relay.allow_legacy=VOICE_RELAY_PROTOCOL==1;
    mbedtls_entropy_init(&l->entropy); mbedtls_ctr_drbg_init(&l->random);
}
bool voice_transport_legacy(const voice_transport_t *l) { return l->websocket && l->relay.legacy; }
static const char *device_key(const voice_transport_t *link)
{
    // Same diagnostic fallback for both relay versions. The API bearer key
    // still authenticates the connection. An unpaired ID cannot load resident
    // settings or save history as a registered household device.
    if (link->diagnostic) return "e84-diagnostic-unpaired";
    return DOOR_DEVICE_KEY[0] ? DOOR_DEVICE_KEY : "e84-diagnostic-unpaired";
}
void voice_transport_close(voice_transport_t *l)
{
    if (l->socket!=CY_SOCKET_INVALID_HANDLE) cy_socket_delete(l->socket);
    mbedtls_ctr_drbg_free(&l->random); mbedtls_entropy_free(&l->entropy);
    voice_transport_init(l);
}
static bool option(voice_transport_t *l, int level, int name, const void *p, size_t n)
{
    cy_rslt_t result=cy_socket_setsockopt(l->socket,level,name,p,(uint32_t)n);
    if (result!=CY_RSLT_SUCCESS)
        printf("[VOICE] Socket option failed: level=%d option=%d result=0x%08lx.\n",
            level,name,(unsigned long)result);
    return result==CY_RSLT_SUCCESS;
}
static bool send_all(voice_transport_t *l, const uint8_t *p, size_t n)
{
    TickType_t start=xTaskGetTickCount();
    while (n) {
        uint32_t sent=0;
        if (xTaskGetTickCount()-start>pdMS_TO_TICKS(2000)) {
            printf("[VOICE] %s send stalled for 2 seconds.\n",l->websocket?"Server":"M5");
            return false;
        }
        cy_rslt_t result=cy_socket_send(l->socket,p,(uint32_t)n,0,&sent);
        if (sent>n) return false;
        if (result==CY_RSLT_MODULE_SECURE_SOCKETS_WOULDBLOCK ||
            result==CY_RSLT_MODULE_SECURE_SOCKETS_TIMEOUT) {
            p+=sent; n-=sent;
            if (n) vTaskDelay(1); /* bounded backpressure, not a disconnect */
            continue;
        }
        if (result!=CY_RSLT_SUCCESS || !sent) {
            printf("[VOICE] %s send failed: result=0x%08lx bytes=%lu remaining=%lu.\n",
                l->websocket?"Server":"M5",(unsigned long)result,(unsigned long)sent,(unsigned long)n);
            return false;
        }
        p+=sent; n-=sent;
    }
    return true;
}
/* Preserve partial bytes even when the SDK's exact-length TLS read times out. */
static int receive(voice_transport_t *l, uint8_t *p, size_t wanted, size_t *used)
{
    uint32_t n=0;
    cy_rslt_t result=cy_socket_recv(l->socket,p+*used,(uint32_t)(wanted-*used),0,&n);
    if (n>wanted-*used) return -1;
    *used+=n;
    if (n) l->progress=xTaskGetTickCount();
    if (result!=CY_RSLT_SUCCESS && result!=CY_RSLT_MODULE_SECURE_SOCKETS_TIMEOUT &&
        result!=CY_RSLT_MODULE_SECURE_SOCKETS_WOULDBLOCK) {
        printf("[VOICE] %s receive failed: result=0x%08lx.\n",l->websocket?"Server":"M5",(unsigned long)result);
        return -1;
    }
    if (result==CY_RSLT_SUCCESS && !n) {
        printf("[VOICE] %s socket closed by peer.\n",l->websocket?"Server":"M5");
        return -1;
    }
    return *used==wanted ? 1 : 0;
}
static bool connect_socket(voice_transport_t *l, const char *host, uint16_t port, bool tls)
{
    cy_socket_ip_address_t address;
    if (cy_socket_gethostbyname(host,CY_SOCKET_IP_VER_V4,&address)!=CY_RSLT_SUCCESS) return false;
    cy_socket_sockaddr_t remote={.ip_address=address,.port=port};
    if (cy_socket_create(CY_SOCKET_DOMAIN_AF_INET,CY_SOCKET_TYPE_STREAM,
        tls?CY_SOCKET_IPPROTO_TLS:CY_SOCKET_IPPROTO_TCP,&l->socket)!=CY_RSLT_SUCCESS) return false;
    uint32_t timeout=10000;
    if (!option(l,CY_SOCKET_SOL_SOCKET,CY_SOCKET_SO_RCVTIMEO,&timeout,sizeof(timeout)) ||
        !option(l,CY_SOCKET_SOL_SOCKET,CY_SOCKET_SO_SNDTIMEO,&timeout,sizeof(timeout))) return false;
    if (tls) {
        cy_socket_tls_auth_mode_t auth=CY_SOCKET_TLS_VERIFY_REQUIRED;
        if (!option(l,CY_SOCKET_SOL_TLS,CY_SOCKET_SO_TLS_AUTH_MODE,&auth,sizeof(auth)) ||
            !option(l,CY_SOCKET_SOL_TLS,CY_SOCKET_SO_TRUSTED_ROOTCA_CERTIFICATE,DOOR_ROOT_CA_PEM,strlen(DOOR_ROOT_CA_PEM)) ||
            !option(l,CY_SOCKET_SOL_TLS,CY_SOCKET_SO_SERVER_NAME_INDICATION,host,strlen(host)) ||
            !option(l,CY_SOCKET_SOL_TLS,CY_SOCKET_SO_ALPN_PROTOCOLS,"http/1.1",8)) return false;
    }
    cy_rslt_t result=cy_socket_connect(l->socket,&remote,sizeof(remote));
    if (result!=CY_RSLT_SUCCESS) {
        printf("[VOICE] %s connection failed: 0x%08lx\n",tls?"TLS":"M5",(unsigned long)result);
        return false;
    }
    /* 20 ms audio frames must leave immediately rather than waiting for
     * another segment or a delayed ACK (both links also carry control). */
    uint8_t no_delay=1;
    timeout=1000;
    return option(l,CY_SOCKET_SOL_TCP,CY_SOCKET_SO_TCP_NODELAY,&no_delay,sizeof(no_delay)) &&
        option(l,CY_SOCKET_SOL_SOCKET,CY_SOCKET_SO_SNDTIMEO,&timeout,sizeof(timeout));
}
static bool poll_timeout(voice_transport_t *l)
{
    uint32_t timeout=1;
    l->progress=xTaskGetTickCount();
    return option(l,CY_SOCKET_SOL_SOCKET,CY_SOCKET_SO_RCVTIMEO,&timeout,sizeof(timeout));
}
bool voice_transport_m5(voice_transport_t *l)
{
    if (!m5_link_destination_is_local() || M5_PORT>=65535u) return false;
    return connect_socket(l,M5_IPV4,(uint16_t)(M5_PORT+1u),false) && poll_timeout(l);
}
bool voice_transport_server(voice_transport_t *l)
{
    if (!voice_relay_settings_valid(DOOR_RELAY_MODE,device_key(l))) {
        printf("[VOICE] Relay settings missing/invalid: set DOOR_DEVICE_KEY and DOOR_RELAY_MODE in .env, run python3 configure_api.py, then rebuild/program.\n");
        return false;
    }
    if (l->diagnostic || !DOOR_DEVICE_KEY[0])
        printf("[VOICE] Unpaired diagnostic session; resident settings/history unavailable.\n");
    if (!DOOR_API_HOST[0] || strlen(DOOR_API_HOST)>127 || strlen(DOOR_API_KEY)<32 || strlen(DOOR_API_KEY)>511)
        return false;
    for (const char *p=DOOR_API_KEY;*p;++p) if ((unsigned char)*p<33 || (unsigned char)*p>126) return false;
    for (const char *p=DOOR_API_HOST;*p;++p)
        if (!((*p>='a'&&*p<='z') || (*p>='A'&&*p<='Z') || (*p>='0'&&*p<='9') || *p=='-' || *p=='.')) return false;
    const unsigned char personal[]="e84-voice-websocket";
    if (mbedtls_ctr_drbg_seed(&l->random,mbedtls_entropy_func,&l->entropy,personal,sizeof(personal)-1)) return false;
    l->random_ready=true;
    if (!connect_socket(l,DOOR_API_HOST,443,true)) return false;
    uint8_t nonce[16], digest[20]; unsigned char key[32], expected[32]; size_t n;
    if (mbedtls_ctr_drbg_random(&l->random,nonce,sizeof(nonce)) ||
        mbedtls_base64_encode(key,sizeof(key),&n,nonce,sizeof(nonce))) return false;
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
    TickType_t start=xTaskGetTickCount();
    while (used<sizeof(response)-1 && xTaskGetTickCount()-start<pdMS_TO_TICKS(15000)) {
        size_t one=0;
        int r=receive(l,(uint8_t *)response+used,1,&one);
        used+=one;
        if (r<0) return false;
        if (used>=4 && !memcmp(response+used-4,"\r\n\r\n",4)) break;
    }
    response[used]=0;
    if (!voice_ws_upgrade_valid(response,(char *)expected)) {
        /* Do not print arbitrary server content or echoed Authorization. */
        printf("[VOICE] WebSocket upgrade rejected. Check /api/relay authentication and proxy Upgrade forwarding.\n");
        return false;
    }
    l->websocket=true;
    return poll_timeout(l);
}
static bool websocket_send(voice_transport_t *l, uint8_t op, const uint8_t *p, size_t n)
{
    uint8_t frame[VOICE_PACKET+8], mask[4];
    if (n>VOICE_PACKET || mbedtls_ctr_drbg_random(&l->random,mask,4)) return false;
    size_t h=2; frame[0]=0x80|op;
    if (n<126) frame[1]=0x80|(uint8_t)n;
    else { frame[1]=0xfe; frame[2]=(uint8_t)(n>>8); frame[3]=(uint8_t)n; h=4; }
    memcpy(frame+h,mask,4); h+=4;
    for (size_t i=0;i<n;++i) frame[h+i]=p[i]^mask[i%4];
    return send_all(l,frame,h+n);
}
bool voice_transport_send(voice_transport_t *l, const voice_header_t *h, const void *payload)
{
    if (l->socket==CY_SOCKET_INVALID_HANDLE) return false;
    uint8_t wire[VOICE_PACKET];
    if (l->websocket) {
        char uuid[37]={0};
        if (h->type==VOICE_HELLO) {
            uint8_t random[16];
            if (mbedtls_ctr_drbg_random(&l->random,random,sizeof(random))) return false;
            random[6]=(random[6]&15)|0x40; random[8]=(random[8]&63)|0x80;
            (void)snprintf(uuid,sizeof(uuid),"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                random[0],random[1],random[2],random[3],random[4],random[5],random[6],random[7],
                random[8],random[9],random[10],random[11],random[12],random[13],random[14],random[15]);
        }
        size_t length; uint8_t opcode;
        if (!voice_relay_encode(&l->relay,h,payload,uuid,DOOR_RELAY_MODE,
                device_key(l),
                wire,sizeof(wire),&length,&opcode)) return false;
        bool sent=!length || websocket_send(l,opcode,wire,length);
        memset(wire,0,sizeof(wire)); /* start contains the private device key */
        return sent;
    }
    if (!voice_header_encode(wire,h) || (h->length && !payload)) return false;
    if (h->length) memcpy(wire+VOICE_HEADER,payload,h->length);
    return send_all(l,wire,VOICE_HEADER+h->length);
}
static int unpack(voice_transport_t *l, voice_packet_t *p)
{
    if (l->message_used<VOICE_HEADER || !voice_header_decode(l->message,&p->header) ||
        l->message_used!=VOICE_HEADER+p->header.length) return -1;
    memcpy(p->payload,l->message+VOICE_HEADER,p->header.length);
    l->message_used=0; return 1;
}
int voice_transport_poll(voice_transport_t *l, voice_packet_t *p)
{
    if (l->socket==CY_SOCKET_INVALID_HANDLE) return -1;
    if ((l->header_used || l->message_used || l->frame_used || l->fragmented) &&
        xTaskGetTickCount()-l->progress>pdMS_TO_TICKS(5000)) {
        printf("[VOICE] %s partial receive stalled for 5 seconds.\n",l->websocket?"Server":"M5");
        return -1;
    }
    if (!l->websocket) {
        int r;
        if (l->message_used<VOICE_HEADER) {
            r=receive(l,l->message,VOICE_HEADER,&l->message_used); if (r<=0) return r;
        }
        voice_header_t h;
        if (!voice_header_decode(l->message,&h)) return -1;
        if (l->message_used<VOICE_HEADER+h.length) {
            r=receive(l,l->message,VOICE_HEADER+h.length,&l->message_used); if (r<=0) return r;
        }
        return unpack(l,p);
    }
    l->relay.clock_ms=(uint32_t)((uint64_t)xTaskGetTickCount()*1000u/pdMS_TO_TICKS(1000));
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
        int r=receive(l,l->frame_header,2,&l->header_used);
        if (r<=0) {
            if (!r && !l->header_used && !l->fragmented)
                return voice_relay_pending(&l->relay,l->relay.clock_ms,&p->header,p->payload);
            return r;
        }
    }
    if ((l->frame_header[1]&127)==126 && l->header_used<4) {
        int r=receive(l,l->frame_header,4,&l->header_used); if (r<=0) return r;
    }
    if (voice_ws_header(l->frame_header,l->header_used,&l->opcode,&l->final,&l->frame_length)<=0) return -1;
    if (l->frame_used<l->frame_length) {
        int r=receive(l,l->frame,l->frame_length,&l->frame_used); if (r<=0) return r;
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
    if (result<0) printf("[VOICE] Invalid/incompatible /api/relay message.\n");
    return result;
}
