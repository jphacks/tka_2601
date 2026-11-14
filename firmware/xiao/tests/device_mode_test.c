#include "device_mode.h"
#include "net_stream.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Host test for the household-mode follower: strict parsing, last-good
 * retention across failures and reboot, stop-mode gating and the sync cadence.
 * Nothing here talks to a real server or real NVS. */
extern unsigned fake_mode_reads, fake_mode_writes;
extern bool fake_mode_stored, fake_mode_fail_write;
extern uint8_t fake_mode_value;

static unsigned checks;
static void check(bool condition) { ++checks; assert(condition); }

/* --- Fakes for the network and the voice task. */
struct net_stream { const char *response; size_t offset; };
static const char *script[48];
static size_t script_count, script_next;
static char requests[48][512];
static unsigned request_count;
static bool voice_busy;
static unsigned opens;
static uint32_t fake_now;
static char *current_request;
bool voice_stream_busy(void) { return voice_busy; }
uint32_t net_now_ms(void) { return fake_now; }
void net_sleep_ms(uint32_t ms) { fake_now += ms; }
net_stream_t *net_stream_open(const char *host, uint16_t port, const char *ca)
{
    check(!strcmp(host,"settings.example.test") && port==443 && !strcmp(ca,"test-device-settings-ca"));
    check(script_next<script_count);
    ++opens;
    const char *next=script[script_next++];
    if(!next) return NULL; /* connection failure */
    net_stream_t *stream=calloc(1,sizeof(*stream)); stream->response=next;
    current_request=requests[request_count++]; current_request[0]=0;
    return stream;
}
int net_stream_write(net_stream_t *stream, const void *data, size_t length)
{
    (void)stream; size_t used=strlen(current_request);
    check(used+length<sizeof(requests[0])); memcpy(current_request+used,data,length); current_request[used+length]=0;
    return (int)length;
}
int net_stream_read(net_stream_t *stream, void *data, size_t capacity)
{
    size_t left=strlen(stream->response)-stream->offset;
    if(!left) return -1;
    size_t n=left<capacity?left:capacity; if(n>16) n=16; /* small reads exercise reassembly */
    memcpy(data,stream->response+stream->offset,n); stream->offset+=n; return (int)n;
}
void net_stream_close(net_stream_t *stream) { free(stream); }

static char responses[48][512];
static size_t response_count;
static const char *http(unsigned status, const char *body)
{
    char *out=responses[response_count++];
    snprintf(out,512,"HTTP/1.1 %u X\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",status,strlen(body),body);
    return out;
}
static void queue(const char *response) { check(script_count<48); script[script_count++]=response; }
static void forget(void) { script_count=script_next=request_count=response_count=0; }
static const char *mode_json(const char *mode)
{
    static char buf[16][128]; static unsigned n;
    char *out=buf[n++%16];
    snprintf(out,128,"{\"contract_version\":1,\"paired\":true,\"mode\":%s}",mode);
    return out;
}
static const char *quoted(const char *mode)
{
    static char buf[16][32]; static unsigned n;
    char *out=buf[n++%16]; snprintf(out,32,"\"%s\"",mode); return out;
}
static device_mode_parse_t parse(const char *json, device_mode_t *mode)
{ return device_mode_parse((const uint8_t *)json,strlen(json),mode); }

static void parsing_is_strict(void)
{
    device_mode_t mode=0;
    const char *names[]={"normal","omakase","away","off"};
    for(unsigned i=0;i<4;++i) {
        mode=0; check(parse(mode_json(quoted(names[i])),&mode)==DEVICE_MODE_PARSE_OK);
        check(mode==(device_mode_t)(i+1) && !strcmp(device_mode_name(mode),names[i]));
    }
    /* Unknown, differently cased, padded or empty names are invalid, never "off". */
    const char *bad[]={"\"OFF\"","\"Normal\"","\"paused\"","\"\"","\"off \"","\"stop\"","\"off\\u0000\"","0","1","true","[]","{}","\"normal\\n\""};
    for(unsigned i=0;i<sizeof(bad)/sizeof(*bad);++i) {
        mode=DEVICE_MODE_AWAY; check(parse(mode_json(bad[i]),&mode)==DEVICE_MODE_PARSE_INVALID && mode==DEVICE_MODE_AWAY);
    }
    check(parse("{\"contract_version\":1,\"paired\":false,\"mode\":null}",&mode)==DEVICE_MODE_PARSE_UNPAIRED && mode==DEVICE_MODE_AWAY);
    /* Paired without a mode, unpaired with a mode, wrong contract, missing or duplicate fields. */
    const char *invalid[]={
        "{\"contract_version\":1,\"paired\":true,\"mode\":null}",
        "{\"contract_version\":1,\"paired\":false,\"mode\":\"off\"}",
        "{\"contract_version\":2,\"paired\":true,\"mode\":\"off\"}",
        "{\"contract_version\":\"1\",\"paired\":true,\"mode\":\"off\"}",
        "{\"paired\":true,\"mode\":\"off\"}",
        "{\"contract_version\":1,\"mode\":\"off\"}",
        "{\"contract_version\":1,\"paired\":true}",
        "{\"contract_version\":1,\"paired\":true,\"mode\":\"off\",\"mode\":\"normal\"}",
        "{\"contract_version\":1,\"paired\":\"true\",\"mode\":\"off\"}",
        "{\"contract_version\":1,\"paired\":true,\"mode\":\"off\"} x",
        "{\"contract_version\":1,\"paired\":true,\"mode\":\"off\"",
        "{\"contract_version\":1,\"paired\":true,\"mode\":\"off\",}",
        "[]", "null", "", "{", "{}"};
    for(unsigned i=0;i<sizeof(invalid)/sizeof(*invalid);++i) {
        mode=DEVICE_MODE_AWAY; check(parse(invalid[i],&mode)==DEVICE_MODE_PARSE_INVALID && mode==DEVICE_MODE_AWAY);
    }
    /* Unknown extra fields are skipped, so the contract can grow compatibly. */
    check(parse("{\"contract_version\":1,\"paired\":true,\"mode\":\"off\",\"future\":{\"a\":[1,2]}}",&mode)==DEVICE_MODE_PARSE_OK && mode==DEVICE_MODE_OFF);
    check(parse("{\"future\":1,\"contract_version\":1,\"paired\":true,\"mode\":\"away\"}",&mode)==DEVICE_MODE_PARSE_OK && mode==DEVICE_MODE_AWAY);
    check(device_mode_parse(NULL,0,&mode)==DEVICE_MODE_PARSE_INVALID);
    check(!device_mode_from_name(NULL,&mode) && !strcmp(device_mode_name(0),"unknown") && !strcmp(device_mode_name(9),"unknown"));
}
static void boot_uses_last_good_then_build_default(void)
{
    /* Nothing was ever fetched: the build-time default. */
    fake_mode_stored=false; device_mode_init();
    check(device_mode_current()==DEVICE_MODE_OMAKASE && device_mode_accepts_calls());
    /* A stored mode survives reboot, including stop mode. */
    for(unsigned m=DEVICE_MODE_NORMAL;m<=DEVICE_MODE_OFF;++m) {
        fake_mode_stored=true; fake_mode_value=(uint8_t)m; device_mode_init();
        check(device_mode_current()==(device_mode_t)m && device_mode_accepts_calls()==(m!=DEVICE_MODE_OFF));
    }
    /* A corrupt stored value is never taken as off or anything else. */
    for(unsigned v=0;v<256;++v) {
        if(v>=DEVICE_MODE_NORMAL && v<=DEVICE_MODE_OFF) continue;
        fake_mode_stored=true; fake_mode_value=(uint8_t)v; device_mode_init();
        check(device_mode_current()==DEVICE_MODE_OMAKASE);
    }
}
static void off_blocks_calls_only(void)
{
    fake_mode_stored=false; fake_mode_fail_write=false; device_mode_init();
    check(device_mode_gate_call(true) && !device_mode_gate_call(false));
    check(device_mode_apply(DEVICE_MODE_OFF) && device_mode_current()==DEVICE_MODE_OFF);
    check(!device_mode_gate_call(true) && !device_mode_gate_call(false) && !device_mode_accepts_calls());
    check(device_mode_apply(DEVICE_MODE_AWAY) && device_mode_gate_call(true) && !strcmp(device_mode_relay_name(),"away"));
    check(!device_mode_apply((device_mode_t)0) && !device_mode_apply((device_mode_t)5) && device_mode_current()==DEVICE_MODE_AWAY);
}
static void storage_is_written_once_and_retried(void)
{
    fake_mode_stored=false; device_mode_init();
    unsigned writes=fake_mode_writes;
    check(device_mode_apply(DEVICE_MODE_AWAY) && fake_mode_writes==writes+1 && fake_mode_value==DEVICE_MODE_AWAY);
    check(device_mode_apply(DEVICE_MODE_AWAY) && fake_mode_writes==writes+1); /* unchanged: no flash wear */
    /* Storage failure: the app's mode still takes effect now; the save is retried. */
    fake_mode_fail_write=true;
    check(!device_mode_apply(DEVICE_MODE_OFF) && device_mode_current()==DEVICE_MODE_OFF && fake_mode_value==DEVICE_MODE_AWAY);
    check(!device_mode_apply(DEVICE_MODE_OFF));
    fake_mode_fail_write=false;
    check(device_mode_apply(DEVICE_MODE_OFF) && fake_mode_value==DEVICE_MODE_OFF);
}
uint32_t device_http_retry_interval(uint32_t interval);
static bool request_is(unsigned index, const char *line)
{
    return index<request_count && !strncmp(requests[index],line,strlen(line)) &&
        strstr(requests[index],"Authorization: Bearer test-device-key\r\n") &&
        strstr(requests[index],"apikey: test-publishable-key\r\n");
}
/* Advance the clock, run one network-task iteration, and count connection attempts. */
static unsigned step(uint32_t advance, bool ready)
{
    unsigned before=opens; fake_now+=advance; device_mode_sync_step(ready); return opens-before;
}
/* A fetch that changes the running mode is followed by one PUT /mode-status
 * (covered in device_mode_report_test.c); acknowledge it without moving the clock. */
static void settle_report(const char *mode)
{
    unsigned before=request_count;
    queue(http(200,"{\"applied_mode\":\"x\",\"applied_mode_at\":\"2026-11-06T00:00:00Z\"}"));
    check(step(0,true)==1 && request_is(before,"PUT /functions/v1/device/mode-status HTTP/1.1"));
    char body[32]; snprintf(body,sizeof(body),"{\"mode\":\"%s\"}",mode);
    check(strstr(requests[before],body)!=NULL);
}
static void sync_cadence_and_last_good(void)
{
    check(device_http_retry_interval(0)==10000 && device_http_retry_interval(10000)==20000 &&
          device_http_retry_interval(20000)==40000 && device_http_retry_interval(40000)==60000 &&
          device_http_retry_interval(60000)==60000);
    fake_mode_stored=false; fake_mode_fail_write=false; device_mode_init(); forget();
    fake_now=1000;
    /* No request while the network is down or a call is running; chimes are never waited for. */
    check(step(1,false)==0);
    voice_busy=true; check(step(1,true)==0); voice_busy=false;
    /* First step fetches the mode; stop mode applies at once and is saved. */
    queue(http(200,mode_json(quoted("off"))));
    check(step(1,true)==1 && request_is(0,"GET /functions/v1/device/mode-settings HTTP/1.1"));
    check(device_mode_current()==DEVICE_MODE_OFF && fake_mode_stored && fake_mode_value==DEVICE_MODE_OFF);
    settle_report("off");
    /* Next step is the first heartbeat; an acknowledged one waits a full minute. */
    queue(http(200,"{\"last_heartbeat_at\":\"2026-11-06T00:00:00Z\"}"));
    check(step(1,true)==1 && request_is(2,"PUT /functions/v1/device/heartbeat HTTP/1.1"));
    check(strstr(requests[2],"Content-Length: 0\r\n")!=NULL);
    check(step(14000,true)==0);
    /* The app changes the mode: followed at the next 15 s poll. */
    queue(http(200,mode_json(quoted("normal"))));
    check(step(1000,true)==1 && device_mode_current()==DEVICE_MODE_NORMAL && fake_mode_value==DEVICE_MODE_NORMAL);
    settle_report("normal");
    queue(http(200,mode_json(quoted("away"))));
    check(step(15000,true)==1 && device_mode_current()==DEVICE_MODE_AWAY);
    settle_report("away");
    /* A malformed value keeps the last good mode (never off), and the poll retries after 10 s. */
    queue(http(200,mode_json(quoted("OFF"))));
    check(step(15000,true)==1 && device_mode_current()==DEVICE_MODE_AWAY && fake_mode_value==DEVICE_MODE_AWAY);
    check(step(9999,true)==0);
    /* A rejected credential: same, with the retry delay doubling (20 s). */
    queue(http(401,"{\"error\":\"unauthorized\"}"));
    check(step(1,true)==1 && device_mode_current()==DEVICE_MODE_AWAY && fake_mode_value==DEVICE_MODE_AWAY);
    /* A lost heartbeat is not contact: it retries after 10 s, then 20 s, not after a minute. */
    queue(NULL);
    check(step(5000,true)==1 && step(9999,true)==0);
    queue(http(500,"oops"));
    check(step(1,true)==1 && device_mode_current()==DEVICE_MODE_AWAY);
    /* The mode poll backs off to 40 s after a second failure and still keeps the last good mode. */
    queue(http(500,"oops"));
    check(step(5000,true)==1 && device_mode_current()==DEVICE_MODE_AWAY);
    /* An acknowledged heartbeat restores the 60 s cadence. */
    queue(http(200,"{\"last_heartbeat_at\":\"2026-11-06T00:05:00Z\"}"));
    check(step(15000,true)==1 && step(1,true)==0);
    /* Recovery: the next successful fetch is followed and polling returns to 15 s. */
    queue(http(200,mode_json(quoted("normal"))));
    check(step(24999,true)==1 && device_mode_current()==DEVICE_MODE_NORMAL && fake_mode_value==DEVICE_MODE_NORMAL);
    settle_report("normal");
    queue(http(200,mode_json(quoted("away"))));
    check(step(14999,true)==0 && step(1,true)==1 && device_mode_current()==DEVICE_MODE_AWAY);
    settle_report("away");
}
static void unpaired_keeps_last_good(void)
{
    fake_mode_fail_write=false; check(device_mode_apply(DEVICE_MODE_OFF));
    unsigned writes=fake_mode_writes, before=request_count;
    queue(http(200,"{\"contract_version\":1,\"paired\":false,\"mode\":null}"));
    check(step(15000,true)==1 && request_is(before,"GET /functions/v1/device/mode-settings"));
    check(device_mode_current()==DEVICE_MODE_OFF && fake_mode_writes==writes);
}
int main(void)
{
    parsing_is_strict();
    boot_uses_last_good_then_build_default();
    off_blocks_calls_only();
    storage_is_written_once_and_retried();
    sync_cadence_and_last_good();
    unpaired_keeps_last_good();
    printf("device mode: %u checks passed\n",checks);
    return 0;
}
