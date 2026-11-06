#include "device_mode.h"
#include "device_http.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdio.h>
#include <stdlib.h>

#define MODE_POLL_MS 15000u
#define HEARTBEAT_MS 60000u

/* One request per step, so a slow server never holds the network task for
 * more than the 10 s HTTP bound. Mode fetch, mode report and heartbeat retry
 * independently, and none waits for the others or for the chime path.
 *
 * PUT /mode-status tells the cloud which mode this device is actually running
 * (devices.applied_mode), separately from the mode saved in the app. It is sent
 * only when the running mode came from a successful fetch in this boot, so a
 * mode taken from NVS or the build-time default is never presented as the
 * app's setting. It is sent once after the first successful fetch and again
 * only when the running mode differs from the last acknowledged report. */
void device_mode_sync_step(bool network_ready) {
    static uint32_t mode_at, mode_interval, mode_retry, heartbeat_at, heartbeat_interval, heartbeat_retry;
    static uint32_t report_at, report_interval, report_retry;
    static bool mode_tried, heartbeat_tried, report_tried;
    /* fetched: the running mode was set by a fetch. reported/attempted: 0 = none. */
    static bool fetched;
    static device_mode_t reported, attempted;
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
            /* Applied in RAM even when the save fails, so it is what the device is running. */
            if(!device_mode_apply(mode)) xlog("[MODE] fetch=ok applied=%s saved=no\n",device_mode_name(mode));
            fetched=true;
            mode_interval=MODE_POLL_MS; mode_retry=0;
        } else if(parsed==DEVICE_MODE_PARSE_UNPAIRED) {
            xlog("[MODE] Device is not paired; keeping %s.\n",device_mode_name(device_mode_current()));
            /* No cloud mode to compare with: report again once a fetch succeeds after pairing. */
            fetched=false; reported=0; attempted=0;
            mode_interval=MODE_POLL_MS; mode_retry=0;
        } else {
            /* Unreachable, rejected or malformed: the last good mode stays in force. */
            xlog("[MODE] fetch=failed status=%u; keeping %s.\n",status,device_mode_name(device_mode_current()));
            mode_retry=device_http_retry_interval(mode_retry); mode_interval=mode_retry;
        }
        mode_at=net_now_ms();
        return;
    }
    device_mode_t running=device_mode_current();
    bool report_due=fetched && reported!=running &&
        (!report_tried || attempted!=running || (uint32_t)(now-report_at)>=report_interval);
    if(report_due) {
        if(attempted!=running) report_retry=0; /* a newer mode starts a fresh backoff */
        report_tried=true; attempted=running;
        char body[32];
        int length=snprintf(body,sizeof(body),"{\"mode\":\"%s\"}",device_mode_name(running));
        response_t *response=device_http_request("PUT","/functions/v1/device/mode-status",body,(size_t)length);
        bool ok=response && response->status==200u;
        unsigned status=response?response->status:0u;
        free(response);
        /* Only an acknowledged report counts; a failure never blocks the next step. */
        if(ok) { reported=running; report_retry=0; report_interval=0; }
        else {
            report_retry=device_http_retry_interval(report_retry); report_interval=report_retry;
            xlog("[MODE] report=failed status=%u mode=%s; retrying.\n",status,device_mode_name(running));
        }
        report_at=net_now_ms();
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
