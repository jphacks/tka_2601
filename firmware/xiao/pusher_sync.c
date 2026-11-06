#include "pusher_sync.h"
#include "pusher_protocol.h"
#include "device_http.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdio.h>
#include <stdlib.h>

static bool same_config(const servo_pusher_config_t *a, const servo_pusher_config_t *b) {
    return a->revision==b->revision && a->schema_version==b->schema_version &&
        a->enabled_mask==b->enabled_mask && a->call_start==b->call_start && a->call_end==b->call_end;
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
    if(!device_http_configured() || !network_ready || voice_stream_busy()) return;
    uint32_t now=net_now_ms();
    if(attempted && (uint32_t)(now-last_attempt)<interval) return;
    if(!attempted) changed_at=now;
    attempted=true; last_attempt=now;
    /* A compact authenticated projection keeps unrelated shop menus outside
     * the bounded firmware settings response. */
    response_t *response=device_http_request("GET","/functions/v1/device/pusher-settings",NULL,0);
    if(!response || response->status!=200u) {
        free(response);
        interval=device_http_retry_interval(interval); last_attempt=net_now_ms();
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
    } else if(parsed==PUSHER_SETTINGS_UNPAIRED) {
        /* Provisioning precedes household pairing. No desired update has been
         * observed here, so retain local wiring and any already durable gate. */
        error="device_unpaired";
    } else {
        error=servo_pusher_set_pending(true)?"invalid_settings_response":"storage_failed";
    }
    servo_pusher_config_t actual;
    bool actual_ok=servo_pusher_get(&actual);
    if(!actual_ok) error="storage_failed";
    char body[768]; size_t bytes=pusher_status_encode(body,sizeof(body),actual_ok?&actual:NULL,error,voice_stream_recovery_required(),
                                                     servo_pusher_pin(1),servo_pusher_pin(2));
    if(!bytes) { interval=device_http_retry_interval(interval); last_attempt=net_now_ms(); return; }
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
    response=bytes?device_http_request("PUT","/functions/v1/device/pusher-status",body,bytes):NULL;
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
            response=bytes?device_http_request("PUT","/functions/v1/device/pusher-status",body,bytes):NULL;
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
    } else interval=device_http_retry_interval(interval);
    xlog("[PUSHER] readback=%s revision=%lu sync=%s report=%s\n",actual_ok?"ok":"unavailable",
         (unsigned long)(actual_ok?actual.revision:0),error?error:"applied_or_local",
         status_only_reported?"status_only":report_accepted?"accepted":"not_acknowledged");
}
