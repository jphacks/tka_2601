#include "chime_enroll_sync.h"
#include "chime_enroll_protocol.h"
#include "net_stream.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

/* Host test for the chime-enrollment sync step: request polling, start/cancel,
 * seq dedupe, the busy rule, phase reports, 409 and the reboot baseline.
 * The server and the audio task are fakes: nothing here talks to a real server,
 * a microphone or flash. Each scenario runs in a forked child so that the
 * step's static state starts from a fresh boot every time. */
static unsigned checks, scenarios;
#define check(condition) do { ++checks; if(!(condition)) { fprintf(stderr,"check failed at line %d: %s\n",__LINE__,#condition); abort(); } } while(0)

/* --- Fake audio_app. The audio task takes a queued command on its next tick. */
audio_jobs_t audio_jobs;
static audio_enroll_status_t fake_status;
static bool fake_model_valid, fake_storage_ready, fake_queue_full, fake_audio_accepts;
static char pending_command;
static unsigned start_calls, cancel_calls;
audio_enroll_status_t audio_app_enroll_status(void) { return fake_status; }
bool audio_app_model_valid(void) { return fake_model_valid; }
bool audio_storage_ready(void) { return fake_storage_ready; }
bool audio_app_enroll_start(void) { ++start_calls; if(fake_queue_full) return false; pending_command='e'; return true; }
bool audio_app_enroll_cancel(void) { ++cancel_calls; if(fake_queue_full) return false; pending_command='x'; return true; }
static bool is_active(audio_enroll_phase_t p) { return p==AUDIO_ENROLL_NOISE || p==AUDIO_ENROLL_LISTEN || p==AUDIO_ENROLL_ANALYZE; }
static void audio_tick(void)
{
    char command=pending_command; pending_command=0;
    if(command=='e' && fake_audio_accepts) fake_status=(audio_enroll_status_t){AUDIO_ENROLL_NOISE,CHIME_REASON_NONE};
    /* Like audio_app.c: cancel only changes the phase while a registration runs. */
    if(command=='x' && is_active(fake_status.phase)) fake_status=(audio_enroll_status_t){AUDIO_ENROLL_CANCELLED,CHIME_REASON_NONE};
}
static void set_phase(audio_enroll_phase_t phase, chime_reason_t reason) { fake_status=(audio_enroll_status_t){phase,reason}; }

/* --- Fake network. Routes answer by request line. */
typedef struct { unsigned status; const char *body; unsigned hits; } route_t; /* status 0 = no connection */
static route_t get_route, put_route;
static char put_bodies[512][160];
static uint32_t put_times[512];
static unsigned put_count;
static bool voice_busy;
static uint32_t fake_now;
struct net_stream { char request[1024]; size_t length; char response[600]; size_t size, offset; bool built; };
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
    route_t *route=NULL;
    if(!strncmp(stream->request,"GET /functions/v1/device/chime-enrollment ",strlen("GET /functions/v1/device/chime-enrollment "))) route=&get_route;
    else if(!strncmp(stream->request,"PUT /functions/v1/device/chime-enrollment-status ",strlen("PUT /functions/v1/device/chime-enrollment-status "))) route=&put_route;
    check(route!=NULL);
    ++route->hits;
    check(strstr(stream->request,"Authorization: Bearer test-device-key\r\n") && strstr(stream->request,"apikey: test-publishable-key\r\n"));
    if(route==&put_route) {
        const char *body=strstr(stream->request,"\r\n\r\n")+4;
        check(put_count<512 && strlen(body)<sizeof(put_bodies[0]));
        strcpy(put_bodies[put_count],body); put_times[put_count++]=fake_now;
        char length[32]; snprintf(length,sizeof(length),"Content-Length: %zu\r\n",strlen(body));
        check(strstr(stream->request,length)!=NULL);
    }
    if(!route->status) return;
    const char *body=route->body?route->body:"{}";
    stream->size=(size_t)snprintf(stream->response,sizeof(stream->response),
        "HTTP/1.1 %u X\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",route->status,strlen(body),body);
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

static void get_is(bool paired, unsigned seq, const char *action)
{
    static char buf[8][160]; static unsigned n;
    char *out=buf[n++%8];
    snprintf(out,160,"{\"contract_version\":1,\"paired\":%s,\"request_seq\":%u,\"action\":%s%s%s}",paired?"true":"false",seq,
        action?"\"":"",action?action:"null",action?"\"":"");
    get_route=(route_t){200,out,get_route.hits};
}
static void get_status(unsigned status, const char *body) { get_route=(route_t){status,body,get_route.hits}; }
static void put_is(unsigned status) { put_route=(route_t){status,"{\"handled_seq\":0}",put_route.hits}; }

/* One network-task iteration every `tick` ms; each step makes at most one request. */
static void run_for(uint32_t total, uint32_t tick)
{
    for(uint32_t t=0;t<total;t+=tick) {
        unsigned before=get_route.hits+put_route.hits;
        fake_now+=tick; audio_tick(); chime_enroll_sync_step(true);
        check(get_route.hits+put_route.hits-before<=1);
    }
}
static void boot(void)
{
    fake_now=1000; fake_storage_ready=true; fake_audio_accepts=true; fake_model_valid=false;
    fake_status=(audio_enroll_status_t){AUDIO_ENROLL_IDLE,CHIME_REASON_NONE};
    put_is(200); get_is(true,0,NULL);
}
static bool last_put_is(const char *body) { return put_count && !strcmp(put_bodies[put_count-1],body); }
static unsigned count_puts_with(const char *needle)
{
    unsigned n=0; for(unsigned i=0;i<put_count;++i) n+=strstr(put_bodies[i],needle)!=NULL; return n;
}

/* --- Scenarios. */
static void unpaired_keeps_polling_and_does_nothing(void)
{
    boot(); get_is(false,0,NULL);
    run_for(30000,200);
    check(get_route.hits>=5 && get_route.hits<=7);   /* 5 s cadence, first one at once */
    check(put_route.hits==0 && start_calls==0 && cancel_calls==0);
    /* Even a hostile unpaired body never starts anything. */
    get_status(200,"{\"contract_version\":1,\"paired\":false,\"request_seq\":9,\"action\":\"start\"}");
    run_for(30000,200); check(start_calls==0 && put_route.hits==0);
    get_is(false,0,NULL); run_for(30000,200); check(start_calls==0 && put_route.hits==0);
}
static void poll_cadence_follows_the_device_state(void)
{
    boot(); fake_model_valid=true; get_is(true,0,NULL);
    run_for(2000,200); /* first fetch adopts the baseline; one idle report follows */
    check(get_route.hits==1 && put_count==1 && last_put_is("{\"handled_seq\":0,\"phase\":\"idle\",\"reason\":null,\"registered\":true}"));
    /* Registered and idle: every 15 s, and no keep-alive while idle. */
    unsigned hits=get_route.hits; run_for(150000,200);
    check(get_route.hits-hits>=9 && get_route.hits-hits<=11 && put_count==1);
    /* No chime model yet: every 3 s. */
    fake_model_valid=false; hits=get_route.hits; run_for(30000,200);
    check(get_route.hits-hits>=9 && get_route.hits-hits<=11);
    /* Model back, but an enrollment is running: every 3 s as well. */
    fake_model_valid=true; run_for(20000,200);
    set_phase(AUDIO_ENROLL_LISTEN,CHIME_REASON_NONE); hits=get_route.hits; run_for(30000,200);
    check(get_route.hits-hits>=9 && get_route.hits-hits<=11);
    set_phase(AUDIO_ENROLL_DONE,CHIME_REASON_NONE); run_for(5000,200); hits=get_route.hits; run_for(60000,200);
    check(get_route.hits-hits>=3 && get_route.hits-hits<=5);
    /* A failed fetch backs off 5, 10, 20, 40, 60 s and recovers to the normal cadence. */
    get_status(500,"oops"); hits=get_route.hits; run_for(120000,200);
    check(get_route.hits-hits>=3 && get_route.hits-hits<=6);
    get_is(true,0,NULL); run_for(70000,200); hits=get_route.hits; run_for(60000,200);
    check(get_route.hits-hits>=3 && get_route.hits-hits<=5);
    /* Dropped connection and malformed bodies are failures too, and never start anything. */
    get_status(0,NULL); run_for(30000,200);
    get_status(200,"{\"contract_version\":1,\"paired\":true,\"request_seq\":99,\"action\":\"start\",}"); run_for(30000,200);
    get_status(401,"{\"error\":\"unauthorized\"}"); run_for(30000,200);
    check(start_calls==0);
}
static void a_registered_boot_adopts_the_cloud_sequence_as_handled(void)
{
    /* An old start request is still stored in the cloud when a device that has a chime model reboots. */
    boot(); fake_model_valid=true; get_is(true,5,"start");
    run_for(10000,200);
    check(start_calls==0 && fake_status.phase==AUDIO_ENROLL_IDLE);
    check(put_count==1 && last_put_is("{\"handled_seq\":5,\"phase\":\"idle\",\"reason\":null,\"registered\":true}"));
    unsigned polls=get_route.hits; run_for(60000,200);
    check(get_route.hits>polls && start_calls==0 && put_count==1); /* polled again, still not started */
    /* The next request after the boot baseline is real. */
    get_is(true,6,"start"); run_for(16000,200);
    check(start_calls==1 && fake_status.phase==AUDIO_ENROLL_NOISE);
}
static void an_unregistered_boot_executes_the_pending_request(void)
{
    /* No chime model yet: a start made while the device was offline runs on the first paired answer. */
    boot(); get_is(true,5,"start");
    run_for(6000,200);
    check(start_calls==1 && fake_status.phase==AUDIO_ENROLL_NOISE);
    check(count_puts_with("\"handled_seq\":5,\"phase\":\"noise\"")==1);
    run_for(60000,200); check(start_calls==1); /* deduped afterwards */
}
static void an_unregistered_boot_executes_a_pending_cancel(void)
{
    boot(); get_is(true,5,"cancel");
    run_for(6000,200);
    check(cancel_calls==1 && start_calls==0);
    check(last_put_is("{\"handled_seq\":5,\"phase\":\"cancelled\",\"reason\":null,\"registered\":false}"));
}
static void an_unregistered_boot_with_no_action_just_records_the_sequence(void)
{
    boot(); get_is(true,5,NULL);
    run_for(6000,200);
    check(start_calls==0 && cancel_calls==0);
    check(last_put_is("{\"handled_seq\":5,\"phase\":\"idle\",\"reason\":null,\"registered\":false}"));
}
static void pairing_during_this_boot_makes_the_first_request_new(void)
{
    boot(); get_is(false,0,NULL); run_for(12000,200);
    check(get_route.hits>=2 && put_route.hits==0);
    get_is(true,1,"start"); run_for(6000,200);
    check(start_calls==1 && fake_status.phase==AUDIO_ENROLL_NOISE);
    check(count_puts_with("\"handled_seq\":1,\"phase\":\"noise\"")==1);
}
static void a_start_runs_reports_every_phase_at_once_and_ends_registered(void)
{
    boot(); get_is(true,0,NULL); run_for(1000,200);
    unsigned base=put_count;
    get_is(true,1,"start"); run_for(4000,200);
    check(start_calls==1 && cancel_calls==0);
    check(put_count==base+1 && last_put_is("{\"handled_seq\":1,\"phase\":\"noise\",\"reason\":null,\"registered\":false}"));
    /* Duplicate polls of the same sequence never restart. */
    run_for(60000,200); check(start_calls==1);
    unsigned reports=put_count; check(reports>=base+1);
    struct { audio_enroll_phase_t phase; chime_reason_t reason; bool model; const char *body; } steps[]={
        {AUDIO_ENROLL_LISTEN,CHIME_REASON_NONE,false,"{\"handled_seq\":1,\"phase\":\"listen\",\"reason\":null,\"registered\":false}"},
        /* A short ring only changes the retry hint, which the contract has no field for: nothing new to report. */
        {AUDIO_ENROLL_LISTEN,CHIME_REASON_SHORT,false,NULL},
        {AUDIO_ENROLL_ANALYZE,CHIME_REASON_NONE,false,"{\"handled_seq\":1,\"phase\":\"analyze\",\"reason\":null,\"registered\":false}"},
        {AUDIO_ENROLL_SAVING,CHIME_REASON_NONE,true,"{\"handled_seq\":1,\"phase\":\"saving\",\"reason\":null,\"registered\":true}"},
        {AUDIO_ENROLL_DONE,CHIME_REASON_NONE,true,"{\"handled_seq\":1,\"phase\":\"done\",\"reason\":null,\"registered\":true}"},
    };
    for(unsigned i=0;i<sizeof(steps)/sizeof(*steps);++i) {
        unsigned before=put_count;
        fake_model_valid=steps[i].model; set_phase(steps[i].phase,steps[i].reason);
        uint32_t changed_at=fake_now;
        run_for(400,200); /* two network-task iterations */
        if(steps[i].body) {
            check(put_count==before+1 && last_put_is(steps[i].body));
            check(put_times[put_count-1]-changed_at<=200); /* immediately, not at the next poll */
        } else check(put_count==before);
    }
    /* A finished registration is final: no keep-alive. */
    unsigned finished=put_count; run_for(180000,200); check(put_count==finished);
}
static void a_cancel_is_reported_as_cancelled(void)
{
    boot(); fake_model_valid=false; get_is(true,0,NULL); run_for(1000,200);
    get_is(true,1,"start"); run_for(4000,200); set_phase(AUDIO_ENROLL_LISTEN,CHIME_REASON_NONE); run_for(400,200);
    get_is(true,2,"cancel"); run_for(5000,200);
    check(cancel_calls==1 && start_calls==1 && fake_status.phase==AUDIO_ENROLL_CANCELLED);
    check(last_put_is("{\"handled_seq\":2,\"phase\":\"cancelled\",\"reason\":null,\"registered\":false}"));
    run_for(60000,200); check(cancel_calls==1);
    /* A cancel with nothing running still ends in "cancelled" for that sequence. */
    unsigned before=put_count; get_is(true,3,"cancel"); run_for(6000,200);
    check(cancel_calls==2 && put_count==before+1 && last_put_is("{\"handled_seq\":3,\"phase\":\"cancelled\",\"reason\":null,\"registered\":false}"));
    /* A stale failure is replaced by the cancel as well. */
    set_phase(AUDIO_ENROLL_FAILED,CHIME_REASON_NOISY); run_for(1000,200);
    get_is(true,4,"cancel"); run_for(6000,200);
    check(last_put_is("{\"handled_seq\":4,\"phase\":\"cancelled\",\"reason\":null,\"registered\":false}"));
    /* A cancel that arrives after the model was saved cannot undo it: the result stays done/registered. */
    fake_model_valid=true; set_phase(AUDIO_ENROLL_DONE,CHIME_REASON_NONE); run_for(1000,200);
    get_is(true,5,"cancel"); run_for(16000,200); /* registered and finished: the 15 s cadence */
    check(last_put_is("{\"handled_seq\":5,\"phase\":\"done\",\"reason\":null,\"registered\":true}"));
    /* If the queue is full the cancel cannot be posted; the real phase is reported. */
    fake_queue_full=true; set_phase(AUDIO_ENROLL_LISTEN,CHIME_REASON_NONE); run_for(1000,200);
    get_is(true,6,"cancel"); run_for(6000,200);
    check(last_put_is("{\"handled_seq\":6,\"phase\":\"listen\",\"reason\":null,\"registered\":true}"));
}
static void a_start_the_device_cannot_run_is_busy_and_handled(void)
{
    boot(); get_is(true,0,NULL); run_for(1000,200);
    /* Storage not ready: refused before anything is queued. */
    fake_storage_ready=false; get_is(true,1,"start"); run_for(5000,200);
    check(start_calls==0 && last_put_is("{\"handled_seq\":1,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":false}"));
    run_for(60000,200); check(start_calls==0 && count_puts_with("\"handled_seq\":1,")==1); /* handled: not retried */
    /* The storage task is writing a model, formatting or saving a clip. */
    fake_storage_ready=true; audio_jobs.model_busy=true;
    get_is(true,2,"start"); run_for(5000,200); check(start_calls==0 && last_put_is("{\"handled_seq\":2,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":false}"));
    audio_jobs.model_busy=false; audio_jobs.formatting=true;
    get_is(true,3,"start"); run_for(5000,200); check(start_calls==0 && last_put_is("{\"handled_seq\":3,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":false}"));
    audio_jobs.formatting=false; audio_jobs.clip_busy=true;
    get_is(true,4,"start"); run_for(5000,200); check(start_calls==0 && last_put_is("{\"handled_seq\":4,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":false}"));
    audio_jobs.clip_busy=false;
    /* The command queue is full. */
    fake_queue_full=true; get_is(true,5,"start"); run_for(5000,200);
    check(start_calls==1 && last_put_is("{\"handled_seq\":5,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":false}"));
    fake_queue_full=false;
    /* The audio task drops the command (a call started in between): busy after the wait, never "started". */
    fake_audio_accepts=false; get_is(true,6,"start"); run_for(1000,200);
    check(count_puts_with("\"handled_seq\":6,")==0); /* still waiting, nothing reported yet */
    run_for(4000,200);
    check(start_calls==2 && last_put_is("{\"handled_seq\":6,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":false}"));
    /* The refusal does not outlive the next real registration. */
    fake_audio_accepts=true; get_is(true,7,"start"); run_for(5000,200);
    check(last_put_is("{\"handled_seq\":7,\"phase\":\"noise\",\"reason\":null,\"registered\":false}"));
    /* The cloud keeps the busy seq until the app asks again: nothing restarts by itself. */
    unsigned calls=start_calls; run_for(60000,200); check(start_calls==calls);
}
static void a_stale_finished_phase_is_never_reported_for_a_new_start(void)
{
    boot(); fake_model_valid=true; set_phase(AUDIO_ENROLL_DONE,CHIME_REASON_NONE); get_is(true,0,NULL); run_for(1000,200);
    unsigned before=put_count;
    fake_audio_accepts=false; get_is(true,1,"start"); run_for(20000,200);
    for(unsigned i=before;i<put_count;++i) check(!strstr(put_bodies[i],"\"handled_seq\":1,\"phase\":\"done\""));
    check(last_put_is("{\"handled_seq\":1,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":true}"));
}
static unsigned failure_case;
static void failures_map_to_the_contract_reasons(void)
{
    struct { chime_reason_t reason; const char *name; } cases[]={
        {CHIME_REASON_NOISY,"too_noisy"},{CHIME_REASON_SHORT,"too_short"},{CHIME_REASON_CLIPPED,"clipped"},
        {CHIME_REASON_NO_PCM,"no_recording"},{CHIME_REASON_UNSTABLE,"unstable"},{CHIME_REASON_NOISE_MATCH,"background_matches"},
        {CHIME_REASON_NONE,"no_recording"}, /* a call started or the capture had a gap */
    };
    boot(); get_is(true,0,NULL); run_for(1000,200);
    get_is(true,1,"start"); run_for(4000,200);
    set_phase(AUDIO_ENROLL_FAILED,cases[failure_case].reason); run_for(400,200);
    char expected[160]; snprintf(expected,sizeof(expected),
        "{\"handled_seq\":1,\"phase\":\"failed\",\"reason\":\"%s\",\"registered\":false}",cases[failure_case].name);
    check(last_put_is(expected));
    /* A failed registration is final too: no keep-alive. */
    unsigned n=put_count; run_for(130000,200); check(put_count==n);
}
static void keepalive_only_while_a_registration_runs(void)
{
    boot(); get_is(true,0,NULL); run_for(1000,200);
    get_is(true,1,"start"); run_for(4000,200); set_phase(AUDIO_ENROLL_LISTEN,CHIME_REASON_NONE); run_for(400,200);
    unsigned n=put_count; uint32_t t0=put_times[put_count-1];
    run_for(185000,200);
    check(put_count-n>=2 && put_count-n<=4);
    for(unsigned i=n;i<put_count;++i) {
        check(!strcmp(put_bodies[i],"{\"handled_seq\":1,\"phase\":\"listen\",\"reason\":null,\"registered\":false}"));
        check(put_times[i]-t0>=60000 && put_times[i]-t0<=61000); t0=put_times[i];
    }
}
static void a_409_refetches_and_never_loops(void)
{
    /* The cloud rejects every report as out of sequence, from the very first one. */
    boot(); put_is(409); get_is(true,0,NULL);
    run_for(120000,200);
    unsigned put_n=put_route.hits;
    check(put_n>=4 && put_n<=8);                   /* 5, 10, 20, 40, 60 s backoff, not once per step (600 steps) */
    check(get_route.hits>=put_n);                  /* each 409 is followed by a fetch */
    for(unsigned i=1;i<put_count;++i) check(put_times[i]-put_times[i-1]>=5000);
    check(start_calls==0);
}
static void a_409_with_a_lower_cloud_seq_follows_the_cloud(void)
{
    boot(); get_is(true,40,NULL); run_for(1000,200);
    check(last_put_is("{\"handled_seq\":40,\"phase\":\"idle\",\"reason\":null,\"registered\":false}"));
    put_is(409); get_is(true,3,NULL); run_for(20000,200); /* cloud reset to 3 */
    unsigned n=put_count; put_is(200); run_for(20000,200);
    check(count_puts_with("\"handled_seq\":3,")>=1 && last_put_is("{\"handled_seq\":3,\"phase\":\"idle\",\"reason\":null,\"registered\":false}"));
    n=put_count; run_for(60000,200); check(put_count==n && start_calls==0);
    /* The request after the reset is acted on. */
    get_is(true,4,"start"); run_for(6000,200); check(start_calls==1);
}
static void failed_reports_retry_with_backoff_and_a_new_phase_goes_out_at_once(void)
{
    boot(); get_is(true,0,NULL); run_for(1000,200);
    get_is(true,1,"start"); run_for(4000,200);
    put_is(500); set_phase(AUDIO_ENROLL_LISTEN,CHIME_REASON_NONE);
    unsigned before=put_count; run_for(120000,200);
    unsigned attempts=put_count-before; check(attempts>=4 && attempts<=9);
    for(unsigned i=before+1;i<put_count;++i) check(put_times[i]-put_times[i-1]>=5000 && put_times[i]-put_times[i-1]<=61000);
    /* A different phase does not wait for the old failure's backoff. */
    before=put_count; set_phase(AUDIO_ENROLL_ANALYZE,CHIME_REASON_NONE); run_for(400,200);
    check(put_count==before+1 && last_put_is("{\"handled_seq\":1,\"phase\":\"analyze\",\"reason\":null,\"registered\":false}"));
    put_is(200); run_for(70000,200);
    check(count_puts_with("\"phase\":\"analyze\"")>=1);
    /* Polling went on at its own pace through all of it. */
    check(get_route.hits>=40);
    /* A dropped connection is a failure as well. */
    put_is(0); set_phase(AUDIO_ENROLL_SAVING,CHIME_REASON_NONE); before=put_route.hits; run_for(60000,200);
    check(put_route.hits-before>=3 && put_route.hits-before<=7);
}
static void a_call_in_progress_sends_nothing(void)
{
    boot(); get_is(true,0,NULL); run_for(1000,200);
    voice_busy=true; unsigned hits=get_route.hits+put_route.hits;
    get_is(true,1,"start"); set_phase(AUDIO_ENROLL_FAILED,CHIME_REASON_NONE);
    run_for(60000,200);
    check(get_route.hits+put_route.hits==hits && start_calls==0);
    /* After the call the start still arrives, and the failure audio_app recorded is reported. */
    voice_busy=false; fake_audio_accepts=false; run_for(10000,200);
    check(start_calls==1);
    /* Not configured / network down: also silent. */
    hits=get_route.hits+put_route.hits;
    for(unsigned i=0;i<100;++i) { fake_now+=200; chime_enroll_sync_step(false); }
    check(get_route.hits+put_route.hits==hits);
}
static void enrollment_does_not_depend_on_the_device_mode(void)
{
    /* The sync step has no mode input: a start is accepted whatever mode the app chose (stop included). */
    boot(); get_is(true,0,NULL); run_for(1000,200);
    get_is(true,1,"start"); run_for(5000,200);
    check(start_calls==1 && fake_status.phase==AUDIO_ENROLL_NOISE);
}

typedef void (*scenario_t)(void);
static void run_scenario(const char *name, scenario_t scenario)
{
    fflush(stdout);
    pid_t pid=fork(); check(pid>=0);
    if(pid==0) { scenario(); _exit(0); }
    int status=0; check(waitpid(pid,&status,0)==pid);
    if(!(WIFEXITED(status) && WEXITSTATUS(status)==0)) { printf("FAILED: %s\n",name); exit(1); }
    ++scenarios;
}
#define SCENARIO(f) run_scenario(#f,f)
int main(void)
{
    SCENARIO(unpaired_keeps_polling_and_does_nothing);
    SCENARIO(poll_cadence_follows_the_device_state);
    SCENARIO(a_registered_boot_adopts_the_cloud_sequence_as_handled);
    SCENARIO(an_unregistered_boot_executes_the_pending_request);
    SCENARIO(an_unregistered_boot_executes_a_pending_cancel);
    SCENARIO(an_unregistered_boot_with_no_action_just_records_the_sequence);
    SCENARIO(pairing_during_this_boot_makes_the_first_request_new);
    SCENARIO(a_start_runs_reports_every_phase_at_once_and_ends_registered);
    SCENARIO(a_cancel_is_reported_as_cancelled);
    SCENARIO(a_start_the_device_cannot_run_is_busy_and_handled);
    SCENARIO(a_stale_finished_phase_is_never_reported_for_a_new_start);
    for(failure_case=0;failure_case<7;++failure_case) SCENARIO(failures_map_to_the_contract_reasons);
    SCENARIO(keepalive_only_while_a_registration_runs);
    SCENARIO(a_409_refetches_and_never_loops);
    SCENARIO(a_409_with_a_lower_cloud_seq_follows_the_cloud);
    SCENARIO(failed_reports_retry_with_backoff_and_a_new_phase_goes_out_at_once);
    SCENARIO(a_call_in_progress_sends_nothing);
    SCENARIO(enrollment_does_not_depend_on_the_device_mode);
    printf("chime enroll sync: %u scenarios passed\n",scenarios);
    return 0;
}
