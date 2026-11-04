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
    if(!complete || response->status!=200u) { free(response); return NULL; }
    return response;
}
void pusher_sync_step(bool network_ready) {
    static uint32_t last_attempt, interval=5000;
    static bool attempted;
    if(!configured() || !network_ready || voice_stream_busy()) return;
    uint32_t now=net_now_ms();
    if(attempted && (uint32_t)(now-last_attempt)<interval) return;
    attempted=true; last_attempt=now;
    /* A compact authenticated projection keeps unrelated shop menus outside
     * the bounded firmware settings response. */
    response_t *response=request("GET","/functions/v1/device/pusher-settings",NULL,0);
    if(!response) { interval=interval<30000u?interval*2u:60000u; return; }
    servo_pusher_config_t desired={0};
    pusher_settings_result_t parsed=pusher_settings_parse((uint8_t *)response->body,response->body_length,&desired);
    free(response);
    const char *error=NULL;
    if(parsed==PUSHER_SETTINGS_CONFIG) {
        servo_pusher_config_t current;
        bool current_ok=servo_pusher_get(&current);
        bool changed=!current_ok || current.revision!=desired.revision || current.schema_version!=desired.schema_version ||
            current.enabled_mask!=desired.enabled_mask || current.call_start!=desired.call_start || current.call_end!=desired.call_end;
        servo_pusher_set_pending(changed);
        if(changed && voice_stream_recovery_required()) error="manual_check_required";
        else {
            servo_config_result_t applied=servo_pusher_apply(&desired);
            error=servo_pusher_result_error(applied);
            if(error && !error[0]) error=NULL;
            if(applied==SERVO_CONFIG_APPLIED || applied==SERVO_CONFIG_UNCHANGED) servo_pusher_set_pending(false);
        }
    } else if(parsed==PUSHER_SETTINGS_LOCAL || parsed==PUSHER_SETTINGS_MISSING) {
        servo_pusher_set_pending(false);
    } else {
        servo_pusher_set_pending(true);
        error=parsed==PUSHER_SETTINGS_UNPAIRED?"device_unpaired":"invalid_settings_response";
    }
    servo_pusher_config_t actual;
    bool actual_ok=servo_pusher_get(&actual);
    if(!actual_ok) error="storage_failed";
    char body[768]; size_t bytes=pusher_status_encode(body,sizeof(body),actual_ok?&actual:NULL,error,voice_stream_recovery_required(),
                                                     servo_pusher_pin(1),servo_pusher_pin(2));
    response=bytes?request("PUT","/functions/v1/device/pusher-status",body,bytes):NULL;
    if(response) { free(response); interval=5000u; }
    else interval=10000u;
    xlog("[PUSHER] readback=%s revision=%lu sync=%s\n",actual_ok?"ok":"unavailable",
         (unsigned long)(actual_ok?actual.revision:0),error?error:"applied_or_local");
}
