#include "audio_store.h"
#include "audio_upload.h"
#include "door_server.h"
#include "net_stream.h"
#include "voice_stream.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static const char *reply;
static size_t reply_at, reply_limit;
static bool connect_ok, call_busy;
static char request[300000];
static size_t request_used;
static uint32_t clock_ms;
static const char *opened_host;
static net_stream_t *const stream=(net_stream_t *)0x77;
uint32_t net_now_ms(void) { return clock_ms; }
void net_sleep_ms(uint32_t ms) { clock_ms+=ms; }
void net_random(void *o,size_t n) { memset(o,1,n); }
bool voice_stream_busy(void) { return call_busy; }
net_stream_t *net_stream_open(const char *host,uint16_t port,const char *ca)
{ assert(port==443 && ca && ca[0]); opened_host=host; reply_at=0; request_used=0; return connect_ok?stream:NULL; }
void net_stream_close(net_stream_t *s) { assert(s==stream); }
int net_stream_write(net_stream_t *s,const void *d,size_t n)
{
    assert(s==stream); if (n>200) n=200;
    assert(request_used+n<=sizeof(request));
    memcpy(request+request_used,d,n); request_used+=n; return (int)n;
}
int net_stream_read(net_stream_t *s,void *d,size_t n)
{
    assert(s==stream);
    if (!reply) { clock_ms+=1000; return 0; } /* server silent */
    size_t left=strlen(reply)-reply_at;
    if (!left) return -1;
    if (n>left) n=left;
    if (n>reply_limit) n=reply_limit;
    memcpy(d,reply+reply_at,n); reply_at+=n; return (int)n;
}
static uint8_t flash[AUDIO_STORE_BYTES];
static bool fr(uint32_t o,void *p,size_t n) { memcpy(p,flash+o,n); return true; }
static bool fw(uint32_t o,const void *p,size_t n) { const uint8_t *b=p; for(size_t i=0;i<n;++i) flash[o+i]&=b[i]; return true; }
static bool fe(uint32_t o,size_t n) { memset(flash+o,255,n); return true; }
int main(void)
{
    connect_ok=true; reply_limit=9;
    /* API status check: authenticated GET, only HTTP 200 passes. */
    reply="HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\n{\"ready\":true}";
    assert(door_server_check());
    assert(!strcmp(opened_host,"example.test"));
    request[request_used]=0;
    assert(strstr(request,"GET /api/status HTTP/1.1\r\n") && strstr(request,"Authorization: Bearer test-only-"));
    reply="HTTP/1.1 503 Busy\r\nContent-Length: 0\r\n\r\n"; assert(!door_server_check());
    reply="garbage\r\n\r\n"; assert(!door_server_check());
    reply="HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\ncut short"; assert(!door_server_check());
    reply=NULL; clock_ms=0; assert(!door_server_check()); assert(clock_ms>=30000u); /* deadline */
    connect_ok=false; assert(!door_server_check());
    connect_ok=true;
    /* Upload: WAV in, ACK only for this exact event ID. */
    assert(audio_upload_configured());
    memset(flash,255,sizeof(flash));
    audio_flash_t ops={fr,fw,fe};
    audio_store_t store;
    assert(!audio_store_open(&store,ops) && audio_store_format(&store));
    int16_t pcm[1000]; for (unsigned i=0;i<1000;++i) pcm[i]=(int16_t)i;
    uint32_t id[4]={0x01234567,0x89abcdef,0x01234567,0x89abcdef};
    assert(audio_store_enqueue(&store,pcm,1000,id,0.125f));
    unsigned slot=AUDIO_EVENT_FIRST_SLOT;
    const char ack[]="HTTP/1.1 201 Created\r\nContent-Length: 33\r\n\r\n0123456789abcdef0123456789abcdef\n";
    reply=ack; reply_limit=1000;
    assert(audio_upload(&store,slot));
    assert(!strcmp(opened_host,"upload.example.test"));
    request[request_used]=0;
    assert(strstr(request,"PUT /v1/doorbell/recordings/0123456789abcdef0123456789abcdef HTTP/1.1\r\n"));
    assert(strstr(request,"Authorization: Bearer upload-token") && strstr(request,"Content-Length: 2044\r\n"));
    assert(strstr(request,"X-Audio-Match-Score: 0.12500"));
    const char *body=strstr(request,"\r\n\r\n")+4;
    assert((size_t)(request+request_used-body)==2044u && !memcmp(body,"RIFF",4));
    assert(!memcmp(body+44,pcm,2000));
    /* Wrong or missing ACK retains the recording. */
    reply="HTTP/1.1 201 Created\r\nContent-Length: 33\r\n\r\nffffffffffffffffffffffffffffffff\n"; assert(!audio_upload(&store,slot));
    reply="HTTP/1.1 500 Oops\r\nContent-Length: 33\r\n\r\n0123456789abcdef0123456789abcdef\n"; assert(!audio_upload(&store,slot));
    assert(!audio_upload(&store,1u)); /* not a recording slot */
    /* A starting call takes priority over an upload in progress. */
    call_busy=true; reply=ack; assert(!audio_upload(&store,slot)); call_busy=false;
    puts("PASS: authenticated status check, WAV upload, event-ID ACK, deadlines and call priority");
    return 0;
}
