#include "device_mode.h"
#include "device_http.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdlib.h>

#define MODE_POLL_MS 15000u
#define HEARTBEAT_MS 60000u

/* One request per step, so a slow server never holds the network task for
 * more than the 10 s HTTP bound. Heartbeat and mode retry independently, and
 * neither waits for the other or for the chime path. */
void device_mode_sync_step(bool network_ready) {
    static uint32_t mode_at, mode_interval, mode_retry, heartbeat_at, heartbeat_interval, heartbeat_retry;
    static bool mode_tried, heartbeat_tried;
    if(!device_http_configured() || !network_ready || voice_stream_busy()) return;
    uint32_t now=net_now_ms();
    bool mode_due=!mode_tried || (uint32_t)(now-mode_at)>=mode_interval;
    bool heartbeat_due=!heartbeat_tried || (uint32_t)(now-heartbeat_at)>=heartbeat_interval;
    if(mode_due) {
        mode_tried=true;
        response_t *response=device_http_request("GET","/functions/v1/device/mode-settings",NULL,0);
        device_mode_t mode=0; device_mode_parse_t parsed=DEVICE_MODE_PARSE_INVALID;
        unsigned status=response?response->status:0u;
        if(response && status==200u) parsed=device_mode_parse((const uint8_t *)response->body,response->body_length,&mode);
        free(response);
        if(parsed==DEVICE_MODE_PARSE_OK) {
            if(!device_mode_apply(mode)) xlog("[MODE] fetch=ok applied=%s saved=no\n",device_mode_name(mode));
            mode_interval=MODE_POLL_MS; mode_retry=0;
        } else if(parsed==DEVICE_MODE_PARSE_UNPAIRED) {
            xlog("[MODE] Device is not paired; keeping %s.\n",device_mode_name(device_mode_current()));
            mode_interval=MODE_POLL_MS; mode_retry=0;
        } else {
            /* Unreachable, rejected or malformed: the last good mode stays in force. */
            xlog("[MODE] fetch=failed status=%u; keeping %s.\n",status,device_mode_name(device_mode_current()));
            mode_retry=device_http_retry_interval(mode_retry); mode_interval=mode_retry;
        }
        mode_at=net_now_ms();
        return;
    }
    if(heartbeat_due) {
        heartbeat_tried=true;
        response_t *response=device_http_request("PUT","/functions/v1/device/heartbeat","",0);
        bool ok=response && response->status==200u;
        free(response);
        /* Only an acknowledged heartbeat counts as contact; a failure retries sooner. */
        if(ok) { heartbeat_retry=0; heartbeat_interval=HEARTBEAT_MS; }
        else { heartbeat_retry=device_http_retry_interval(heartbeat_retry); heartbeat_interval=heartbeat_retry; }
        heartbeat_at=net_now_ms();
        if(!ok) xlog("[MODE] heartbeat=failed; retrying.\n");
    }
}
