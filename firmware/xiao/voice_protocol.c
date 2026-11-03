#include "voice_protocol.h"
#include <string.h>
#include <ctype.h>

bool voice_header_valid(const voice_header_t *h)
{
    if (!h->session || h->type < VOICE_HELLO || h->type > VOICE_AUDIO_ACK ||
        h->length > VOICE_PAYLOAD) return false;
    if (h->flags && !((h->type==VOICE_INPUT_END || h->type==VOICE_OUTPUT_END) && h->flags==1))
        return false;
    if (h->type==VOICE_INPUT_AUDIO || h->type==VOICE_OUTPUT_AUDIO)
        return h->length >= 2 && h->length <= 640 && !(h->length & 1);
    if (h->type==VOICE_HELLO || h->type==VOICE_ERROR)
        return h->sequence==0;
    if (h->length) return false;
    return h->sequence==0 || h->type==VOICE_INPUT_END || h->type==VOICE_OUTPUT_END ||
        h->type==VOICE_PLAYBACK_DONE || h->type==VOICE_AUDIO_ACK ||
        h->type==VOICE_PING || h->type==VOICE_PONG;
}
int voice_ws_header(const uint8_t *p, size_t n, uint8_t *op, bool *fin, size_t *len)
{
    if (n<2) return 0;
    if ((p[0]&0x70) || (p[1]&0x80)) return -1;
    *op=p[0]&15; *fin=(p[0]&0x80)!=0; *len=p[1]&127;
    if (*op!=0 && *op!=1 && *op!=2 && *op!=8 && *op!=9 && *op!=10) return -1;
    if (*op>=8 && (!*fin || *len>125 || (*op==8 && *len==1))) return -1;
    int header=2;
    if (*len==127) return -1; /* every legal packet fits the 16-bit form */
    if (*len==126) {
        if (n<4) return 0;
        *len=(size_t)p[2]*256+p[3]; header=4;
        if (*len<126) return -1;
    }
    return *len>VOICE_PACKET ? -1 : header;
}
static bool ci_equal(const char *a, size_t n, const char *b)
{
    if (n!=strlen(b)) return false;
    for (size_t i=0;i<n;++i) if (tolower((unsigned char)a[i])!=tolower((unsigned char)b[i])) return false;
    return true;
}
static bool has_token(const char *a, size_t n, const char *token)
{
    size_t pos=0;
    while (pos<n) {
        while (pos<n && (a[pos]==' ' || a[pos]=='\t' || a[pos]==',')) ++pos;
        size_t start=pos; while (pos<n && a[pos]!=',') ++pos;
        size_t end=pos; while (end>start && (a[end-1]==' ' || a[end-1]=='\t')) --end;
        if (ci_equal(a+start,end-start,token)) return true;
    }
    return false;
}
bool voice_ws_upgrade_valid(const char *p, const char *accept)
{
    if (strncmp(p,"HTTP/1.1 101 ",13)) return false;
    p=strstr(p,"\r\n"); if (!p) return false; p+=2;
    unsigned upgrade=0, connection=0, accepted=0;
    for (;;) {
        const char *end=strstr(p,"\r\n"); if (!end) return false;
        if (end==p) return upgrade==1 && connection>=1 && accepted==1;
        const char *colon=memchr(p,':',(size_t)(end-p)); if (!colon || colon==p) return false;
        const char *value=colon+1, *tail=end;
        while (value<tail && (*value==' ' || *value=='\t')) ++value;
        while (tail>value && (tail[-1]==' ' || tail[-1]=='\t')) --tail;
        size_t key=(size_t)(colon-p), n=(size_t)(tail-value);
        if (ci_equal(p,key,"upgrade")) { if (!ci_equal(value,n,"websocket")) return false; ++upgrade; }
        else if (ci_equal(p,key,"connection")) { if (has_token(value,n,"upgrade")) ++connection; }
        else if (ci_equal(p,key,"sec-websocket-accept")) {
            if (n!=strlen(accept) || memcmp(value,accept,n)) return false;
            ++accepted;
        } else if (ci_equal(p,key,"sec-websocket-extensions") || ci_equal(p,key,"sec-websocket-protocol"))
            return false;
        p=end+2;
    }
}
