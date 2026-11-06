#include "device_mode.h"
#include "net_stream.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Host test for PUT /mode-status: what the device reports as the mode it is
 * running, and when. Starts from a fresh process so "once after boot" is real.
 * The fake server answers by request line, so heartbeat, fetch and report are
 * exercised together. Nothing here talks to a real server or real NVS. */
extern bool fake_mode_stored, fake_mode_fail_write;
extern uint8_t fake_mode_value;

static unsigned checks;
static void check(bool condition) { ++checks; assert(condition); }

typedef struct { unsigned status; const char *body; unsigned hits; } route_t; /* status 0 = no connection */
static route_t fetch_route, report_route, heartbeat_route;
static char report_bodies[256][40];
static uint32_t report_times[256];
static unsigned report_count;
static bool voice_busy;
static uint32_t fake_now;

struct net_stream { char request[1024]; size_t length; char response[600]; size_t size, offset; bool built; route_t *route; };
bool voice_stream_busy(void) { return voice_busy; }
uint32_t net_now_ms(void) { return fake_now; }
void net_sleep_ms(uint32_t ms) { fake_now += ms; }
net_stream_t *net_stream_open(const char *host, uint16_t port, const char *ca)
{
    check(!strcmp(host,"settings.example.test") && port==443 && !strcmp(ca,"test-device-settings-ca"));
    return calloc(1,sizeof(net_stream_t));
}
int net_stream_write(net_stream_t *stream, const void *data, size_t length)
{
    check(stream->length+length<sizeof(stream->request));
    memcpy(stream->request+stream->length,data,length); stream->length+=length; stream->request[stream->length]=0;
    return (int)length;
}
static void build(net_stream_t *stream)
{
    stream->built=true;
    const char *line=stream->request;
    stream->route=!strncmp(line,"GET /functions/v1/device/mode-settings ",39)?&fetch_route:
        !strncmp(line,"PUT /functions/v1/device/mode-status ",37)?&report_route:
        !strncmp(line,"PUT /functions/v1/device/heartbeat ",35)?&heartbeat_route:NULL;
    check(stream->route!=NULL);
    ++stream->route->hits;
    check(strstr(stream->request,"Authorization: Bearer test-device-key\r\n") && strstr(stream->request,"apikey: test-publishable-key\r\n"));
    if(stream->route==&report_route) {
        const char *body=strstr(stream->request,"\r\n\r\n")+4;
        check(report_count<256 && strlen(body)<sizeof(report_bodies[0]));
        strcpy(report_bodies[report_count],body); report_times[report_count++]=fake_now;
        char length[32]; snprintf(length,sizeof(length),"Content-Length: %zu\r\n",strlen(body));
        check(strstr(stream->request,length)!=NULL);
    }
    if(!stream->route->status) return; /* connection lost before any response */
    const char *body=stream->route->body?stream->route->body:"{}";
    stream->size=(size_t)snprintf(stream->response,sizeof(stream->response),
        "HTTP/1.1 %u X\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",stream->route->status,strlen(body),body);
}
int net_stream_read(net_stream_t *stream, void *data, size_t capacity)
{
    if(!stream->built) build(stream);
    size_t left=stream->size-stream->offset;
    if(!left) return -1;
    size_t n=left<capacity?left:capacity; if(n>16) n=16;
    memcpy(data,stream->response+stream->offset,n); stream->offset+=n; return (int)n;
}
void net_stream_close(net_stream_t *stream) { free(stream); }

static const char *mode_json(const char *mode)
{
    static char buf[8][128]; static unsigned n;
    char *out=buf[n++%8];
    snprintf(out,128,"{\"contract_version\":1,\"paired\":true,\"mode\":%s}",mode);
    return out;
}
static void fetch_ok(const char *mode_name) {
    static char quoted[8][24]; static unsigned n;
    char *q=quoted[n++%8]; snprintf(q,24,"\"%s\"",mode_name);
    fetch_route=(route_t){200,mode_json(q),fetch_route.hits};
}
static void fetch_is(unsigned status, const char *body) { fetch_route=(route_t){status,body,fetch_route.hits}; }
static void report_is(unsigned status) { report_route=(route_t){status,"{\"applied_mode\":\"x\",\"applied_mode_at\":\"2026-11-06T00:00:00Z\"}",report_route.hits}; }
static void heartbeat_is(unsigned status) { heartbeat_route=(route_t){status,"{\"last_heartbeat_at\":\"2026-11-06T00:00:00Z\"}",heartbeat_route.hits}; }

/* One network-task iteration every `tick` ms for `total` ms; each step makes at most one request. */
static void run_for(uint32_t total, uint32_t tick)
{
    for(uint32_t t=0;t<total;t+=tick) {
        unsigned before=fetch_route.hits+report_route.hits+heartbeat_route.hits;
        fake_now+=tick; device_mode_sync_step(true);
        check(fetch_route.hits+report_route.hits+heartbeat_route.hits-before<=1);
    }
}
static bool last_report_is(const char *mode)
{
    char body[32]; snprintf(body,sizeof(body),"{\"mode\":\"%s\"}",mode);
    return report_count && !strcmp(report_bodies[report_count-1],body);
}

static void a_default_or_stored_mode_is_never_reported(void)
{
    fake_mode_stored=true; fake_mode_value=DEVICE_MODE_AWAY; fake_mode_fail_write=false; device_mode_init();
    check(device_mode_current()==DEVICE_MODE_AWAY);
    heartbeat_is(200); report_is(200);
    /* Every kind of failed fetch for 4 minutes: the stored mode keeps running and nothing is reported. */
    unsigned kinds[4]={0,401,500,200};
    const char *bodies[4]={NULL,"{\"error\":\"unauthorized\"}","oops","{\"contract_version\":1,\"paired\":true,\"mode\":\"OFF\"}"};
    for(unsigned round=0;round<4;++round) {
        fetch_is(kinds[round],bodies[round]);
        run_for(60000,1000);
        check(device_mode_current()==DEVICE_MODE_AWAY && device_mode_accepts_calls());
    }
    check(fetch_route.hits>=5 && heartbeat_route.hits>=3 && report_route.hits==0 && report_count==0);
    /* The build-time default is no different. */
    fake_mode_stored=false; device_mode_init();
    check(device_mode_current()==DEVICE_MODE_OMAKASE);
    run_for(60000,1000);
    check(report_route.hits==0);
    /* A call in progress sends nothing at all. */
    voice_busy=true; unsigned hits=fetch_route.hits+heartbeat_route.hits; run_for(60000,1000);
    check(fetch_route.hits+heartbeat_route.hits==hits && report_route.hits==0); voice_busy=false;
}
static void first_fetch_reports_once_even_if_the_mode_is_unchanged(void)
{
    /* The device already runs away from the first fetch to the boot. The cloud still holds away too:
     * the first success of a boot reports anyway, so the app sees a fresh report time. */
    fake_mode_stored=true; fake_mode_value=DEVICE_MODE_AWAY; device_mode_init();
    fetch_ok("away"); report_is(500);
    run_for(15000,500);
    check(report_route.hits>=1 && last_report_is("away") && device_mode_current()==DEVICE_MODE_AWAY);
}
static void failed_reports_back_off_and_never_block_anything(void)
{
    /* The server rejects the report: 500 first, then 409 (device unpaired meanwhile) - same treatment. */
    unsigned start=report_count, fetches=fetch_route.hits, heartbeats=heartbeat_route.hits;
    run_for(120000,500);
    report_is(409); run_for(120000,500);
    unsigned attempts=report_count-start;
    check(attempts>=4 && attempts<=14); /* bounded, not once per step (480 steps) */
    for(unsigned i=start+1;i<report_count;++i) {
        uint32_t gap=report_times[i]-report_times[i-1];
        check(gap>=5000 && gap<=61000);
        if(i>start+2) check(gap>=report_times[i-1]-report_times[i-2] || gap>=59000); /* never shrinks until capped */
    }
    check(report_times[report_count-1]-report_times[report_count-2]>=59000); /* capped at 60 s */
    /* Fetch (15 s) and heartbeat (60 s) went on at their own cadence; the running mode never changed. */
    check(fetch_route.hits-fetches>=14 && heartbeat_route.hits-heartbeats>=3);
    check(device_mode_current()==DEVICE_MODE_AWAY && device_mode_gate_call(true));
    /* A dropped connection counts as failure too. */
    report_is(0); run_for(60000,500); check(report_count-start>attempts);
}
static void an_acknowledged_report_is_not_repeated(void)
{
    report_is(200); run_for(70000,500);
    unsigned count=report_count; check(last_report_is("away"));
    run_for(300000,1000);
    check(report_count==count); /* same mode, fetched every 15 s, never re-reported */
}
static void a_changed_mode_is_reported_once(void)
{
    unsigned count=report_count;
    fetch_ok("off"); run_for(40000,500);
    check(report_count==count+1 && last_report_is("off") && !device_mode_accepts_calls());
    fetch_ok("normal"); run_for(40000,500);
    check(report_count==count+2 && last_report_is("normal") && device_mode_accepts_calls());
    fetch_ok("omakase"); run_for(40000,500);
    check(report_count==count+3 && last_report_is("omakase"));
    /* The mode is reported even when it cannot be saved: it is what the device is running. */
    fake_mode_fail_write=true; fetch_ok("away"); run_for(40000,500);
    check(report_count==count+4 && last_report_is("away") && device_mode_current()==DEVICE_MODE_AWAY);
    fake_mode_fail_write=false; run_for(40000,500);
    check(report_count==count+4);
}
static void a_newer_mode_does_not_wait_for_an_old_backoff(void)
{
    unsigned count=report_count;
    report_is(500); fetch_ok("off"); run_for(30000,500);
    unsigned attempts=report_count-count; check(attempts>=1 && last_report_is("off"));
    /* The next poll sees normal and reports it at once, with a fresh 10 s, 20 s backoff of its own. */
    fetch_ok("normal"); unsigned before_normal=report_count; run_for(45000,500);
    unsigned normal_attempts=0;
    for(unsigned i=before_normal;i<report_count;++i) normal_attempts+=!strcmp(report_bodies[i],"{\"mode\":\"normal\"}");
    check(last_report_is("normal") && normal_attempts>=3);
    report_is(200); run_for(70000,500);
    check(last_report_is("normal") && device_mode_current()==DEVICE_MODE_NORMAL);
    unsigned settled=report_count; run_for(120000,1000); check(report_count==settled);
}
static void unpaired_forgets_the_report_until_the_next_successful_fetch(void)
{
    unsigned count=report_count;
    fetch_is(200,"{\"contract_version\":1,\"paired\":false,\"mode\":null}");
    run_for(60000,1000);
    check(report_count==count && device_mode_current()==DEVICE_MODE_NORMAL);
    fetch_ok("normal"); run_for(40000,500);
    check(report_count==count+1 && last_report_is("normal")); /* paired again: reported once more, same mode */
}
int main(void)
{
    a_default_or_stored_mode_is_never_reported();
    first_fetch_reports_once_even_if_the_mode_is_unchanged();
    failed_reports_back_off_and_never_block_anything();
    an_acknowledged_report_is_not_repeated();
    a_changed_mode_is_reported_once();
    a_newer_mode_does_not_wait_for_an_old_backoff();
    unpaired_forgets_the_report_until_the_next_successful_fetch();
    printf("device mode report: %u checks passed\n",checks);
    return 0;
}
