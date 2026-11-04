#include "pusher_sync.h"
#include "pusher_protocol.h"
#include "api_settings.h"
#include "bounded_http.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdio.h>
#include <stdlib.h>

#if __has_include("device_config.h")
#include "device_config.h"
#endif
#ifndef DEVICE_SETTINGS_HOST
#define DEVICE_SETTINGS_HOST ""
#endif
#ifndef DEVICE_SETTINGS_API_KEY
#define DEVICE_SETTINGS_API_KEY ""
#endif
#ifndef DEVICE_SETTINGS_CA_PEM
#define DEVICE_SETTINGS_CA_PEM ""
#endif

static bool configured(void) {
    size_t host=strlen(DEVICE_SETTINGS_HOST), api=strlen(DEVICE_SETTINGS_API_KEY), key=strlen(DOOR_DEVICE_KEY);
    if(!host || host>127 || !api || api>511 || !key || key>511 || !DEVICE_SETTINGS_CA_PEM[0]) return false;
    for(const char *p=DEVICE_SETTINGS_HOST;*p;++p)
        if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='.'||*p=='-')) return false;
    for(const char *p=DEVICE_SETTINGS_API_KEY;*p;++p) if(*p<33 || *p>126) return false;
    for(const char *p=DOOR_DEVICE_KEY;*p;++p) if(*p<33 || *p>126) return false;
    return true;
}
static response_t *request(const char *method, const char *path, const char *body, size_t bytes) {
    response_t *response=calloc(1,sizeof(*response)); if(!response) return NULL;
    net_stream_t *stream=net_stream_open(DEVICE_SETTINGS_HOST,443,DEVICE_SETTINGS_CA_PEM);
    if(!stream) { free(response); return NULL; }
    char headers[1536];
    int length=snprintf(headers,sizeof(headers),"%s %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\napikey: %s\r\n"
        "Accept: application/json\r\nContent-Type: application/json\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        method,path,DEVICE_SETTINGS_HOST,DOOR_DEVICE_KEY,DEVICE_SETTINGS_API_KEY,(unsigned long)bytes);
    bool ok=length>0 && (size_t)length<sizeof(headers);
    uint32_t start=net_now_ms();
    for(unsigned segment=0;segment<2 && ok;++segment) {
        const uint8_t *data=(const uint8_t *)(segment?body:headers);
        size_t remaining=segment?bytes:(size_t)length;
        while(remaining) {
            int sent=net_stream_write(stream,data,remaining);
            if(sent<0 || (size_t)sent>remaining || net_now_ms()-start>=10000u) { ok=false; break; }
            data+=sent; remaining-=sent; if(!sent) net_sleep_ms(2);
        }
    }
    memset(headers,0,sizeof(headers));
    bool complete=false;
    while(ok && net_now_ms()-start<10000u && response->used<WIRE_LIMIT) {
        int got=net_stream_read(stream,response->wire+response->used,WIRE_LIMIT-response->used);
        if(got>0) response->used+=(size_t)got;
        response_state_t state=parse_response(response,got<0);
        if(state==RESPONSE_COMPLETE) { complete=true; break; }
        if(state==RESPONSE_INVALID || got<0) break;
        if(!got) net_sleep_ms(2);
    }
    net_stream_close(stream);
    if(!complete) { free(response); return NULL; }
    return response;
}
static bool same_config(const servo_pusher_config_t *a, const servo_pusher_config_t *b) {
    return a->revision==b->revision && a->schema_version==b->schema_version &&
        a->enabled_mask==b->enabled_mask && a->call_start==b->call_start && a->call_end==b->call_end;
}
static uint32_t retry_interval(uint32_t interval) {
    if(interval<5000u) interval=5000u;
    return interval<30000u?interval*2u:60000u;
}
static uint32_t healthy_interval(uint32_t now, uint32_t changed_at, bool reported, uint32_t reported_at) {
    uint32_t interval=(uint32_t)(now-changed_at)<30000u?5000u:30000u;
    if(reported) {
        uint32_t elapsed=(uint32_t)(now-reported_at);
        uint32_t remaining=elapsed<60000u?60000u-elapsed:1u;
        if(remaining<interval) interval=remaining;
    }
    return interval;
}
void pusher_sync_step(bool network_ready) {
    static uint32_t last_attempt, interval=5000, changed_at, reported_at;
    static bool attempted, observed, reported, conflict_context;
    static pusher_settings_result_t previous_parsed;
    static servo_pusher_config_t previous_desired;
    static char observed_body[768], reported_body[768];
    static size_t observed_bytes, reported_bytes;
    if(!configured() || !network_ready || voice_stream_busy()) return;
    uint32_t now=net_now_ms();
    if(attempted && (uint32_t)(now-last_attempt)<interval) return;
    if(!attempted) changed_at=now;
    attempted=true; last_attempt=now;
    /* A compact authenticated projection keeps unrelated shop menus outside
     * the bounded firmware settings response. */
    response_t *response=request("GET","/functions/v1/device/pusher-settings",NULL,0);
    if(!response || response->status!=200u) {
        free(response);
        interval=retry_interval(interval); last_attempt=net_now_ms();
        return;
    }
    servo_pusher_config_t desired={0};
    pusher_settings_result_t parsed=pusher_settings_parse((uint8_t *)response->body,response->body_length,&desired);
    free(response);
    const char *error=NULL;
    if(parsed==PUSHER_SETTINGS_CONFIG) {
        servo_pusher_config_t current;
        bool current_ok=servo_pusher_get(&current);
        bool changed=!current_ok || current.revision!=desired.revision || current.schema_version!=desired.schema_version ||
            current.enabled_mask!=desired.enabled_mask || current.call_start!=desired.call_start || current.call_end!=desired.call_end;
        if(changed && !servo_pusher_set_pending(true)) error="storage_failed";
        else if(changed && voice_stream_recovery_required()) error="manual_check_required";
        else {
            servo_config_result_t applied=servo_pusher_apply(&desired);
            error=servo_pusher_result_error(applied);
            if(error && !error[0]) error=NULL;
            if((applied==SERVO_CONFIG_APPLIED || applied==SERVO_CONFIG_UNCHANGED) &&
               !servo_pusher_set_pending(false)) error="storage_failed";
        }
    } else if(parsed==PUSHER_SETTINGS_LOCAL || parsed==PUSHER_SETTINGS_MISSING) {
        /* Absence is compatible with legacy devices, but cannot erase an
         * already observed update, including one preserved across restart. */
        if(servo_pusher_pending()) error="settings_missing";
    } else {
        error=servo_pusher_set_pending(true)?
            (parsed==PUSHER_SETTINGS_UNPAIRED?"device_unpaired":"invalid_settings_response"):"storage_failed";
    }
    servo_pusher_config_t actual;
    bool actual_ok=servo_pusher_get(&actual);
    if(!actual_ok) error="storage_failed";
    char body[768]; size_t bytes=pusher_status_encode(body,sizeof(body),actual_ok?&actual:NULL,error,voice_stream_recovery_required(),
                                                     servo_pusher_pin(1),servo_pusher_pin(2));
    if(!bytes) { interval=retry_interval(interval); last_attempt=net_now_ms(); return; }
    bool context_changed=!observed || parsed!=previous_parsed ||
        (parsed==PUSHER_SETTINGS_CONFIG && !same_config(&desired,&previous_desired)) ||
        bytes!=observed_bytes || memcmp(body,observed_body,bytes)!=0;
    if(context_changed) {
        changed_at=net_now_ms(); conflict_context=false;
        memcpy(observed_body,body,bytes+1u); observed_bytes=bytes;
        previous_parsed=parsed; previous_desired=desired; observed=true;
    }
    /* Once a rejected ACK's status-only report succeeds, deduplicate that
     * successful projection until desired/actual/runtime/error changes. */
    if(conflict_context) {
        if(!servo_pusher_set_pending(true)) error="storage_failed";
        bytes=pusher_status_encode(body,sizeof(body),NULL,error,voice_stream_recovery_required(),
                                   servo_pusher_pin(1),servo_pusher_pin(2));
    }
    now=net_now_ms();
    bool report_changed=!reported || bytes!=reported_bytes || memcmp(body,reported_body,bytes)!=0;
    bool heartbeat=reported && (uint32_t)(now-reported_at)>=60000u;
    if(!report_changed && !heartbeat) {
        last_attempt=now; interval=healthy_interval(now,changed_at,reported,reported_at);
        return;
    }
    response=bytes?request("PUT","/functions/v1/device/pusher-status",body,bytes):NULL;
    bool report_accepted=response && response->status==200u;
    bool status_only_reported=conflict_context && report_accepted;
    const bool revision_conflict=response && response->status==409u;
    free(response);
    if(revision_conflict) {
        /* A newer cloud save can overtake a locally committed but unreported
         * revision. The next sync still has to fetch/apply desired state. */
        if(!servo_pusher_set_pending(true)) error="storage_failed";
        if(actual_ok && !conflict_context) {
            bytes=pusher_status_encode(body,sizeof(body),NULL,error,voice_stream_recovery_required(),
                                       servo_pusher_pin(1),servo_pusher_pin(2));
            response=bytes?request("PUT","/functions/v1/device/pusher-status",body,bytes):NULL;
            status_only_reported=response && response->status==200u;
            report_accepted=status_only_reported;
            free(response);
            if(status_only_reported) conflict_context=true;
        }
    }
    last_attempt=net_now_ms();
    if(report_accepted) {
        /* A failed PUT must never postpone its retry or the last-success
         * heartbeat, and an ACK rejected with 409 must never enter this cache. */
        memcpy(reported_body,body,bytes+1u); reported_bytes=bytes;
        reported_at=last_attempt; reported=true;
        interval=healthy_interval(last_attempt,changed_at,reported,reported_at);
    } else interval=retry_interval(interval);
    xlog("[PUSHER] readback=%s revision=%lu sync=%s report=%s\n",actual_ok?"ok":"unavailable",
         (unsigned long)(actual_ok?actual.revision:0),error?error:"applied_or_local",
         status_only_reported?"status_only":report_accepted?"accepted":"not_acknowledged");
}
