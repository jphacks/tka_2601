#include "visit_report.h"
#include "net_stream.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Host test for the stop-mode visit queue and its sender: enqueue, dedupe by
 * UUID, overflow, backoff, success removal, invalid clock, and the exact JSON
 * the Edge Function accepts. The network and the clock are fakes; nothing here
 * proves behavior on a real XIAO or a real Supabase. */
static unsigned checks;
#define check(c) do { ++checks; if(!(c)) { fprintf(stderr,"check failed at line %d: %s\n",__LINE__,#c); abort(); } } while(0)

struct net_stream { const char *response; size_t offset; };
static const char *script[16];
static size_t script_count, script_next;
static char requests[16][1024];
static unsigned request_count, opens;
static bool voice_busy;
static uint32_t fake_now;
static char *current_request;
bool voice_stream_busy(void) { return voice_busy; }
uint32_t net_now_ms(void) { return fake_now; }
void net_sleep_ms(uint32_t ms) { fake_now += ms; }
static uint8_t random_seed;
void net_random(void *out, size_t length) { uint8_t *p=out; for(size_t i=0;i<length;++i) p[i]=(uint8_t)(random_seed*17u+i*3u); ++random_seed; }
net_stream_t *net_stream_open(const char *host, uint16_t port, const char *ca)
{
    check(!strcmp(host,"settings.example.test") && port==443 && !strcmp(ca,"test-device-settings-ca"));
    check(script_next<script_count);
    ++opens;
    const char *next=script[script_next++];
    if(!next) return NULL;
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
    size_t n=left<capacity?left:capacity; if(n>16) n=16;
    memcpy(data,stream->response+stream->offset,n); stream->offset+=n; return (int)n;
}
void net_stream_close(net_stream_t *stream) { free(stream); }

static char responses[16][512];
static size_t response_count;
static const char *http(unsigned status, const char *body)
{
    char *out=responses[response_count++];
    snprintf(out,512,"HTTP/1.1 %u X\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n%s",status,strlen(body),body);
    return out;
}
static void queue_response(const char *response) { check(script_count<16); script[script_count++]=response; }
static void forget(void) { script_count=script_next=request_count=response_count=0; }
static unsigned step(uint32_t advance)
{
    unsigned before=opens; fake_now+=advance; visit_report_step(true); return opens-before;
}
/* Empty the queue through the consumer side, whatever its state. */
static void drain(void)
{
    visit_report_entry_t e;
    while(visit_report_pending()) { fake_now+=100000; if(visit_report_peek(fake_now,&e)) visit_report_done(fake_now,VISIT_REPORT_SENT); }
}
static const char *const ID[]={
    "00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003","00000000-0000-4000-8000-000000000004",
    "00000000-0000-4000-8000-000000000005"};
#define T0 1793925723LL /* 2026-11-06T00:42:03Z */

static void time_format(void)
{
    char t[21];
    check(visit_report_format_time(T0,t) && !strcmp(t,"2026-11-06T00:42:03Z"));
    check(visit_report_format_time(1704067200LL,t) && !strcmp(t,"2024-01-01T00:00:00Z"));
    check(visit_report_format_time(1709164800LL+86399,t) && !strcmp(t,"2024-02-29T23:59:59Z")); /* leap day */
    check(visit_report_format_time(1735689599LL,t) && !strcmp(t,"2024-12-31T23:59:59Z"));
    check(visit_report_format_time(1767225600LL,t) && !strcmp(t,"2026-01-01T00:00:00Z"));
    /* An unset RTC (1970 or just before the 2024 floor) is never a chime time. */
    check(!visit_report_format_time(0,t) && !visit_report_format_time(-1,t) && !visit_report_format_time(1704067199LL,t));
    check(!visit_report_format_time(253402300800LL,t));
}
static void body_matches_the_server_contract(void)
{
    /* supabase/functions/device/contract.ts visitFields accepts exactly these keys and
     * device_put_visit requires status in (ringing,in_call,ended,missed); the table
     * CHECKs accept mode "off" and end_reason "mode_off". */
    visit_report_entry_t e; strcpy(e.id,ID[0]); strcpy(e.chimed_at,"2026-11-06T00:42:03Z");
    char body[160];
    size_t n=visit_report_body(&e,body,sizeof(body));
    check(n==strlen(body) && !strcmp(body,
        "{\"status\":\"missed\",\"end_reason\":\"mode_off\",\"mode\":\"off\",\"chimed_at\":\"2026-11-06T00:42:03Z\"}"));
    check(visit_report_body(&e,body,n)==0 && visit_report_body(&e,body,n+1)==n);
}
static void enqueue_dedupe_overflow_and_clock(void)
{
    drain();
    unsigned dropped=visit_report_dropped();
    check(visit_report_enqueue("not-a-uuid",T0)==VISIT_REPORT_BAD_UUID);
    check(visit_report_enqueue("00000000-0000-4000-8000-00000000000G",T0)==VISIT_REPORT_BAD_UUID);
    check(visit_report_enqueue("00000000-0000-4000-8000-00000000000A",T0)==VISIT_REPORT_BAD_UUID); /* uppercase */
    check(visit_report_pending()==0 && visit_report_dropped()==dropped);
    /* Invalid clock: nothing is queued, and it is counted. */
    check(visit_report_enqueue(ID[0],0)==VISIT_REPORT_CLOCK_INVALID && visit_report_pending()==0 && visit_report_dropped()==dropped+1);
    check(visit_report_enqueue(ID[0],T0)==VISIT_REPORT_QUEUED && visit_report_pending()==1);
    /* The same UUID again is the same visit. */
    check(visit_report_enqueue(ID[0],T0+5)==VISIT_REPORT_DUPLICATE && visit_report_pending()==1);
    for(unsigned i=1;i<VISIT_REPORT_QUEUE;++i) check(visit_report_enqueue(ID[i],T0+i)==VISIT_REPORT_QUEUED);
    check(visit_report_pending()==VISIT_REPORT_QUEUE);
    /* Overflow drops the NEW entry; the oldest stay in order. */
    dropped=visit_report_dropped();
    check(visit_report_enqueue(ID[4],T0+9)==VISIT_REPORT_FULL && visit_report_pending()==VISIT_REPORT_QUEUE && visit_report_dropped()==dropped+1);
    check(visit_report_enqueue(ID[1],T0+9)==VISIT_REPORT_DUPLICATE);
    visit_report_entry_t e;
    for(unsigned i=0;i<VISIT_REPORT_QUEUE;++i) {
        check(visit_report_peek(fake_now,&e) && !strcmp(e.id,ID[i]));
        visit_report_done(fake_now,VISIT_REPORT_SENT);
    }
    check(visit_report_pending()==0 && !visit_report_peek(fake_now,&e));
    /* A slot freed by a send is usable again, and wrap-around keeps order. */
    for(unsigned round=0;round<3;++round) {
        for(unsigned i=0;i<3;++i) check(visit_report_enqueue(ID[i],T0)==VISIT_REPORT_QUEUED);
        for(unsigned i=0;i<3;++i) { check(visit_report_peek(fake_now,&e) && !strcmp(e.id,ID[i])); visit_report_done(fake_now,VISIT_REPORT_SENT); }
    }
}
static void send_success_and_wire_format(void)
{
    drain(); forget(); fake_now=1000;
    check(step(1)==0); /* nothing queued: no request */
    check(visit_report_enqueue(ID[0],T0)==VISIT_REPORT_QUEUED);
    voice_busy=true; check(step(1)==0); voice_busy=false; /* never during a call */
    unsigned before=opens; fake_now+=1; visit_report_step(false); check(opens==before); /* network not ready */
    queue_response(http(200,"{\"id\":\"x\",\"applied\":true}"));
    check(step(1)==1 && visit_report_pending()==0);
    check(!strncmp(requests[0],"PUT /functions/v1/device/visits/00000000-0000-4000-8000-000000000001 HTTP/1.1\r\n",75));
    check(strstr(requests[0],"Authorization: Bearer test-device-key\r\n") && strstr(requests[0],"apikey: test-publishable-key\r\n"));
    const char *body=strstr(requests[0],"\r\n\r\n")+4;
    check(!strcmp(body,"{\"status\":\"missed\",\"end_reason\":\"mode_off\",\"mode\":\"off\",\"chimed_at\":\"2026-11-06T00:42:03Z\"}"));
    char length[48]; snprintf(length,sizeof(length),"Content-Length: %zu\r\n",strlen(body));
    check(strstr(requests[0],length)!=NULL);
    check(step(100000)==0); /* nothing left to resend */
}
static void backoff_and_bounded_retries(void)
{
    drain(); forget(); fake_now=500000;
    check(visit_report_enqueue(ID[0],T0)==VISIT_REPORT_QUEUED && visit_report_enqueue(ID[1],T0)==VISIT_REPORT_QUEUED);
    unsigned dropped=visit_report_dropped();
    /* Attempt 1 fails to connect: retry after 10 s, then 20, 40, 60 (capped). */
    queue_response(NULL); check(step(1)==1 && visit_report_pending()==2);
    check(step(9998)==0 && step(1)==0); /* 9999 ms after the failure: still waiting */
    queue_response(http(503,"busy")); check(step(1)==1);
    check(step(19999)==0);
    queue_response(http(500,"oops")); check(step(1)==1);
    check(step(39999)==0);
    queue_response(NULL); check(step(1)==1);
    check(step(59999)==0);
    /* The 5th failure (60 s) is followed by a 6th and last try; then the entry is dropped. */
    queue_response(http(502,"bad gateway")); check(step(1)==1);
    check(step(59999)==0);
    queue_response(http(504,"timeout")); check(step(1)==1);
    check(visit_report_pending()==1 && visit_report_dropped()==dropped+1);
    check(!strstr(requests[request_count-1],"000000000002")); /* the dropped one was the first */
    /* The next entry starts with a fresh budget and no inherited delay. */
    queue_response(http(200,"{}")); check(step(1)==1 && visit_report_pending()==0);
    check(strstr(requests[request_count-1],"000000000002")!=NULL);
    /* A later outage after a success starts again at 10 s. */
    check(visit_report_enqueue(ID[2],T0)==VISIT_REPORT_QUEUED);
    queue_response(NULL); check(step(1)==1 && step(9999)==0);
    queue_response(http(200,"{}")); check(step(1)==1 && visit_report_pending()==0);
}
static void status_classes(void)
{
    drain(); forget(); fake_now=900000;
    /* Rejections the same body cannot fix are dropped at once; 408 and 429 are retried. */
    unsigned permanent[]={400,401,403,404,409,422};
    for(unsigned i=0;i<sizeof(permanent)/sizeof(*permanent);++i) {
        unsigned dropped=visit_report_dropped();
        check(visit_report_enqueue(ID[0],T0)==VISIT_REPORT_QUEUED);
        queue_response(http(permanent[i],"{\"error\":\"x\"}")); check(step(1)==1);
        check(visit_report_pending()==0 && visit_report_dropped()==dropped+1);
    }
    unsigned transient[]={408,429,500,503};
    for(unsigned i=0;i<sizeof(transient)/sizeof(*transient);++i) {
        check(visit_report_enqueue(ID[0],T0)==VISIT_REPORT_QUEUED);
        queue_response(http(transient[i],"{}")); check(step(1)==1 && visit_report_pending()==1);
        queue_response(http(200,"{}")); check(step(10000)==1 && visit_report_pending()==0);
    }
    /* A malformed response (not HTTP) is a transient failure. */
    check(visit_report_enqueue(ID[1],T0)==VISIT_REPORT_QUEUED);
    queue_response("garbage"); check(step(1)==1 && visit_report_pending()==1);
    queue_response(http(204,"")); check(step(10000)==1 && visit_report_pending()==0);
}
static void stop_mode_record(void)
{
    drain(); forget(); fake_now=2000000; random_seed=1;
    /* Clock not set: skipped, never a bogus time. */
    check(visit_report_record_mode_off_at(0,fake_now)==VISIT_REPORT_CLOCK_INVALID && visit_report_pending()==0);
    check(visit_report_record_mode_off_at(T0,fake_now)==VISIT_REPORT_QUEUED && visit_report_pending()==1);
    /* Repeated chimes within 20 s are one visitor; after that a new visit. */
    check(visit_report_record_mode_off_at(T0+1,fake_now+19999)==VISIT_REPORT_DUPLICATE && visit_report_pending()==1);
    check(visit_report_record_mode_off_at(T0+20,fake_now+20000)==VISIT_REPORT_QUEUED && visit_report_pending()==2);
    visit_report_entry_t a,b;
    check(visit_report_peek(fake_now,&a));
    visit_report_done(fake_now,VISIT_REPORT_SENT);
    check(visit_report_peek(fake_now,&b) && strcmp(a.id,b.id)!=0);
    /* Device-generated UUIDs are RFC 4122 version 4, lowercase, 36 characters. */
    check(strlen(a.id)==36 && a.id[14]=='4' && strchr("89ab",a.id[19]) && a.id[8]=='-' && a.id[13]=='-' && a.id[18]=='-' && a.id[23]=='-');
    check(!strcmp(a.chimed_at,"2026-11-06T00:42:03Z") && !strcmp(b.chimed_at,"2026-11-06T00:42:23Z"));
    visit_report_done(fake_now,VISIT_REPORT_SENT);
    /* The real-clock wrapper must queue a valid-looking time on the host. */
    fake_now+=100000; visit_report_record_mode_off();
    check(visit_report_peek(fake_now,&a) && a.chimed_at[0]=='2' && a.chimed_at[20]==0);
    visit_report_done(fake_now,VISIT_REPORT_SENT);
}
static void resend_keeps_the_same_uuid(void)
{
    drain(); forget(); fake_now=3000000;
    check(visit_report_enqueue(ID[3],T0)==VISIT_REPORT_QUEUED);
    queue_response(http(500,"{}")); check(step(1)==1);
    queue_response(http(200,"{}")); check(step(10000)==1 && request_count==2);
    const char *first=strstr(requests[0],"/visits/"), *second=strstr(requests[1],"/visits/");
    check(first && second && !strncmp(first,second,44) && !strncmp(first+8,ID[3],36));
}
int main(void)
{
    time_format();
    body_matches_the_server_contract();
    enqueue_dedupe_overflow_and_clock();
    send_success_and_wire_format();
    backoff_and_bounded_retries();
    status_classes();
    stop_mode_record();
    resend_keeps_the_same_uuid();
    printf("visit_report_test: %u checks passed\n",checks);
    return 0;
}
