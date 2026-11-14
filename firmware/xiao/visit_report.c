#include "visit_report.h"
#include "device_http.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* Single producer (voice task), single consumer (network task). The producer
 * owns head, the consumer owns tail and the retry state, so no lock is needed
 * and the voice task never waits for the network. */
static visit_report_entry_t slots[VISIT_REPORT_QUEUE];
static _Atomic uint32_t head, tail;
static _Atomic unsigned dropped;
/* Consumer only: state of the entry at tail. */
static unsigned attempts;
static uint32_t retry_delay, next_try_ms;
/* Producer only. */
static bool recorded_before;
static uint32_t recorded_at_ms;

bool visit_report_format_time(int64_t unix_seconds, char out[21]) {
    if(unix_seconds<VISIT_REPORT_EARLIEST_VALID_S || unix_seconds>253402300799LL) return false;
    int64_t days=unix_seconds/86400, rest=unix_seconds%86400;
    int64_t z=days+719468, era=z/146097, doe=z-era*146097;
    int64_t yoe=(doe-doe/1460+doe/36524-doe/146096)/365, y=yoe+era*400;
    int64_t doy=doe-(365*yoe+yoe/4-yoe/100), mp=(5*doy+2)/153;
    int64_t d=doy-(153*mp+2)/5+1, m=mp<10?mp+3:mp-9;
    if(m<=2) ++y;
    snprintf(out,21,"%04d-%02d-%02dT%02d:%02d:%02dZ",(int)y,(int)m,(int)d,(int)(rest/3600),(int)(rest%3600/60),(int)(rest%60));
    return true;
}
size_t visit_report_body(const visit_report_entry_t *entry, char *out, size_t capacity) {
    int n=snprintf(out,capacity,"{\"status\":\"missed\",\"end_reason\":\"mode_off\",\"mode\":\"off\",\"chimed_at\":\"%s\"}",entry->chimed_at);
    return n>0 && (size_t)n<capacity ? (size_t)n : 0;
}
static bool uuid_valid(const char *s) {
    if(!s || strlen(s)!=36) return false;
    for(unsigned i=0;i<36;++i) {
        if(i==8||i==13||i==18||i==23) { if(s[i]!='-') return false; }
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false; /* lowercase only: one spelling per visit */
    }
    return true;
}
visit_report_enqueue_t visit_report_enqueue(const char *uuid, int64_t wall_seconds) {
    if(!uuid_valid(uuid)) return VISIT_REPORT_BAD_UUID;
    visit_report_entry_t entry;
    if(!visit_report_format_time(wall_seconds,entry.chimed_at)) { ++dropped; return VISIT_REPORT_CLOCK_INVALID; }
    memcpy(entry.id,uuid,37);
    uint32_t h=head, t=tail;
    for(uint32_t i=t;i!=h;++i) if(!strcmp(slots[i%VISIT_REPORT_QUEUE].id,entry.id)) return VISIT_REPORT_DUPLICATE;
    if(h-t>=VISIT_REPORT_QUEUE) { ++dropped; return VISIT_REPORT_FULL; }
    slots[h%VISIT_REPORT_QUEUE]=entry;
    head=h+1u; /* publishes the entry to the network task */
    return VISIT_REPORT_QUEUED;
}
visit_report_enqueue_t visit_report_record_mode_off_at(int64_t wall_seconds, uint32_t now_ms) {
    if(recorded_before && (uint32_t)(now_ms-recorded_at_ms)<VISIT_REPORT_MIN_GAP_MS) {
        xlog("[VISIT] Repeated chime in stop mode; counted as the same visit.\n");
        return VISIT_REPORT_DUPLICATE;
    }
    uint8_t random[16]; char uuid[37];
    net_random(random,sizeof(random));
    random[6]=(random[6]&15)|0x40; random[8]=(random[8]&63)|0x80;
    snprintf(uuid,sizeof(uuid),"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        random[0],random[1],random[2],random[3],random[4],random[5],random[6],random[7],
        random[8],random[9],random[10],random[11],random[12],random[13],random[14],random[15]);
    visit_report_enqueue_t result=visit_report_enqueue(uuid,wall_seconds);
    if(result==VISIT_REPORT_QUEUED) { recorded_before=true; recorded_at_ms=now_ms; xlog("[VISIT] Stop-mode visit queued for the app (%u waiting).\n",visit_report_pending()); }
    else if(result==VISIT_REPORT_CLOCK_INVALID) xlog("[VISIT] Stop-mode visit not recorded: the clock is not set.\n");
    else if(result==VISIT_REPORT_FULL) xlog("[VISIT] Stop-mode visit not recorded: %u visits are still waiting to be sent.\n",(unsigned)VISIT_REPORT_QUEUE);
    return result;
}
void visit_report_record_mode_off(void) {
    (void)visit_report_record_mode_off_at((int64_t)time(NULL),net_now_ms());
}
unsigned visit_report_pending(void) { return (unsigned)(head-tail); }
unsigned visit_report_dropped(void) { return dropped; }
bool visit_report_peek(uint32_t now_ms, visit_report_entry_t *out) {
    uint32_t t=tail;
    if(head==t) return false;
    if(attempts && (int32_t)(now_ms-next_try_ms)<0) return false;
    *out=slots[t%VISIT_REPORT_QUEUE];
    return true;
}
void visit_report_done(uint32_t now_ms, visit_report_result_t result) {
    if(head==tail) return;
    if(result==VISIT_REPORT_RETRY) {
        ++attempts;
        if(attempts<VISIT_REPORT_MAX_ATTEMPTS) {
            retry_delay=device_http_retry_interval(retry_delay); next_try_ms=now_ms+retry_delay;
            return;
        }
        ++dropped;
        xlog("[VISIT] Giving up on a stop-mode visit after %u tries.\n",attempts);
    } else if(result==VISIT_REPORT_REJECTED) ++dropped;
    attempts=0; retry_delay=0;
    tail=tail+1u;
}
void visit_report_step(bool network_ready) {
    if(!network_ready || !device_http_configured() || voice_stream_busy()) return;
    uint32_t now=net_now_ms();
    visit_report_entry_t entry;
    if(!visit_report_peek(now,&entry)) return;
    char path[96], body[160];
    int path_length=snprintf(path,sizeof(path),"/functions/v1/device/visits/%s",entry.id);
    size_t bytes=visit_report_body(&entry,body,sizeof(body));
    if(path_length<=0 || (size_t)path_length>=sizeof(path) || !bytes) { visit_report_done(now,VISIT_REPORT_REJECTED); return; }
    response_t *response=device_http_request("PUT",path,body,bytes);
    unsigned status=response?response->status:0u;
    free(response);
    visit_report_result_t result=VISIT_REPORT_RETRY;
    if(status>=200u && status<300u) result=VISIT_REPORT_SENT;
    /* Bad request, unpaired, wrong device: resending the same body cannot succeed. */
    else if(status>=400u && status<500u && status!=408u && status!=429u) result=VISIT_REPORT_REJECTED;
    if(result==VISIT_REPORT_SENT) xlog("[VISIT] Stop-mode visit sent.\n");
    else xlog("[VISIT] send=%s status=%u\n",result==VISIT_REPORT_REJECTED?"rejected":"failed",status);
    visit_report_done(net_now_ms(),result);
}
