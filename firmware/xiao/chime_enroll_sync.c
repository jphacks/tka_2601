#include "chime_enroll_sync.h"
#include "chime_enroll_protocol.h"
#include "audio_app.h"
#include "device_http.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdio.h>
#include <stdlib.h>

#define POLL_ACTIVE_MS 3000u   /* enrolling, no chime model yet, or a report not yet acknowledged */
#define POLL_IDLE_MS 15000u
#define POLL_UNPAIRED_MS 5000u
#define KEEPALIVE_MS 60000u    /* only while a registration is running; done/failed/cancelled are final */
#define START_WAIT_MS 2000u    /* the audio task takes a queued command within a few frames */
#define CANCEL_WAIT_MS 1000u

/* One request per step, in this order: a phase change is reported before the
 * next poll, so the app sees it within one network-task iteration (200 ms).
 *
 * Enrollment works in every device mode, including stop: nothing here reads
 * device_mode. A call in progress keeps voice_stream_busy() true, so no request
 * is made, and audio_app itself ends an enrollment when a call starts; the
 * resulting failed phase is reported after the call. */
typedef struct { audio_enroll_phase_t phase; chime_report_reason_t reason; bool registered; uint32_t handled_seq; } report_t;
typedef enum { WAIT_NONE, WAIT_START, WAIT_CANCEL } wait_t;

/* Boot baseline. The first paired answer of a boot is adopted as already handled,
 * so an old request never restarts enrollment after a reboot. Only when this boot
 * saw the device unpaired before that answer is the answer treated as new: pairing
 * happened now, and the app may have asked for enrollment right after. */
static bool baseline_known, saw_unpaired_first, paired_last;
static uint32_t handled_seq;
static bool polled, poll_force;
static uint32_t poll_at, poll_failure; /* poll_failure: current backoff, 0 = last poll worked */
static report_t acked, attempted;
static bool acked_valid, attempted_valid;
static uint32_t acked_at, report_at, report_backoff;
static wait_t waiting;
static uint32_t wait_deadline;
static audio_enroll_phase_t wait_snapshot;
/* A result decided here, not by the audio task (start refused, nothing to cancel).
 * It shows until the audio phase moves away from the one it was decided against. */
static bool override_on;
static audio_enroll_phase_t override_phase, override_snapshot;
static chime_report_reason_t override_reason;

static bool active(audio_enroll_phase_t phase) {
    return phase==AUDIO_ENROLL_NOISE || phase==AUDIO_ENROLL_LISTEN || phase==AUDIO_ENROLL_ANALYZE;
}
static void set_override(audio_enroll_phase_t phase, chime_report_reason_t reason, audio_enroll_phase_t snapshot) {
    override_on=true; override_phase=phase; override_reason=reason; override_snapshot=snapshot;
}
static report_t current_report(void) {
    audio_enroll_status_t status=audio_app_enroll_status();
    report_t r={status.phase,chime_enroll_report_reason(status.phase,status.reason),audio_app_model_valid(),handled_seq};
    if(override_on && status.phase==override_snapshot) { r.phase=override_phase; r.reason=override_reason; }
    else override_on=false;
    return r;
}
static bool same_report(const report_t *a, const report_t *b) {
    return a->phase==b->phase && a->reason==b->reason && a->registered==b->registered && a->handled_seq==b->handled_seq;
}
/* Whether the device can take a start now. audio_app_command() drops 'e' silently
 * in these states; the wait after posting catches any race the checks miss. */
static bool can_start(void) {
    return audio_storage_ready() && !audio_jobs.model_busy && !audio_jobs.formatting && !audio_jobs.clip_busy;
}
static void handle_request(const chime_enroll_request_t *request) {
    audio_enroll_phase_t phase=audio_app_enroll_status().phase;
    handled_seq=request->request_seq;
    override_on=false; waiting=WAIT_NONE;
    if(request->action==CHIME_ENROLL_ACTION_START) {
        if(can_start() && audio_app_enroll_start()) {
            waiting=WAIT_START; wait_snapshot=phase; wait_deadline=net_now_ms()+START_WAIT_MS;
            xlog("[ENROLL] seq=%lu start requested\n",(unsigned long)handled_seq);
        } else {
            set_override(AUDIO_ENROLL_FAILED,CHIME_REPORT_BUSY,phase);
            xlog("[ENROLL] seq=%lu start refused: busy\n",(unsigned long)handled_seq);
        }
    } else if(request->action==CHIME_ENROLL_ACTION_CANCEL) {
        if(audio_app_enroll_cancel()) { waiting=WAIT_CANCEL; wait_snapshot=phase; wait_deadline=net_now_ms()+CANCEL_WAIT_MS; }
        xlog("[ENROLL] seq=%lu cancel requested queued=%u\n",(unsigned long)handled_seq,waiting==WAIT_CANCEL);
    }
}
/* True while a queued start or cancel has not been seen to take effect. */
static bool wait_in_progress(uint32_t now) {
    if(waiting==WAIT_NONE) return false;
    audio_enroll_phase_t phase=audio_app_enroll_status().phase;
    bool expired=(int32_t)(now-wait_deadline)>=0;
    if(waiting==WAIT_START) {
        if(active(phase) && phase!=wait_snapshot) { waiting=WAIT_NONE; return false; }
        if(!expired) return true;
        waiting=WAIT_NONE;
        /* Started and still in the same phase (a restart of NOISE) is a success; anything else was dropped. */
        if(!active(phase)) { set_override(AUDIO_ENROLL_FAILED,CHIME_REPORT_BUSY,phase); xlog("[ENROLL] start dropped: busy\n"); }
        return false;
    }
    if(active(phase) && !expired) return true;
    waiting=WAIT_NONE;
    /* Nothing was running (or a failed/cancelled result is still shown): the cancel stands. A finished
     * or saving enrollment is reported as it is, since the model is already active. */
    if(phase==AUDIO_ENROLL_IDLE || phase==AUDIO_ENROLL_FAILED) set_override(AUDIO_ENROLL_CANCELLED,CHIME_REPORT_NONE,phase);
    return false;
}
static uint32_t poll_interval(bool pending) {
    if(poll_failure) return poll_failure;
    if(!paired_last) return POLL_UNPAIRED_MS;
    if(pending || waiting!=WAIT_NONE || !audio_app_model_valid() || active(audio_app_enroll_status().phase) ||
       audio_app_enroll_status().phase==AUDIO_ENROLL_SAVING) return POLL_ACTIVE_MS;
    return POLL_IDLE_MS;
}
static void poll(void) {
    polled=true; poll_force=false;
    response_t *response=device_http_request("GET","/functions/v1/device/chime-enrollment",NULL,0);
    chime_enroll_request_t request={0};
    chime_enroll_parse_t parsed=CHIME_ENROLL_PARSE_INVALID;
    unsigned status=response?response->status:0u;
    if(response && status==200u) parsed=chime_enroll_parse((const uint8_t *)response->body,response->body_length,&request);
    free(response);
    poll_at=net_now_ms();
    if(parsed==CHIME_ENROLL_PARSE_INVALID) {
        poll_failure=device_http_retry_interval(poll_failure);
        xlog("[ENROLL] fetch=failed status=%u\n",status);
        return;
    }
    poll_failure=0;
    if(parsed==CHIME_ENROLL_PARSE_UNPAIRED) {
        if(paired_last || !baseline_known) xlog("[ENROLL] Device is not paired; waiting for the app.\n");
        paired_last=false;
        if(!baseline_known) saw_unpaired_first=true;
        return;
    }
    paired_last=true;
    if(!baseline_known) {
        baseline_known=true;
        if(!saw_unpaired_first) { handled_seq=request.request_seq; return; }
        handled_seq=0;
    }
    if(request.request_seq<handled_seq) {
        /* The cloud's counter is behind ours (reset); follow it without acting. */
        xlog("[ENROLL] cloud seq=%lu behind handled=%lu; following\n",(unsigned long)request.request_seq,(unsigned long)handled_seq);
        handled_seq=request.request_seq;
    } else if(request.request_seq>handled_seq) handle_request(&request);
}
static bool send_report(const report_t *report, bool keepalive) {
    char body[128];
    size_t length=chime_enroll_status_encode(body,sizeof(body),report->handled_seq,report->phase,report->reason,report->registered);
    if(!length) return false;
    /* A different report starts a new backoff; the same one that failed waits. */
    if(!attempted_valid || !same_report(report,&attempted)) report_backoff=0;
    attempted=*report; attempted_valid=true;
    response_t *response=device_http_request("PUT","/functions/v1/device/chime-enrollment-status",body,length);
    unsigned status=response?response->status:0u;
    free(response);
    report_at=net_now_ms();
    if(status==200u) {
        acked=*report; acked_valid=true; acked_at=report_at; report_backoff=0;
        xlog("[ENROLL] report=ok seq=%lu phase=%s%s\n",(unsigned long)report->handled_seq,chime_enroll_phase_name(report->phase),
             keepalive?" keepalive":"");
        return true;
    }
    report_backoff=device_http_retry_interval(report_backoff);
    if(status==409u) poll_force=true; /* the cloud disagrees on the sequence: fetch again, never loop on the PUT */
    xlog("[ENROLL] report=failed status=%u phase=%s\n",status,chime_enroll_phase_name(report->phase));
    return true;
}
void chime_enroll_sync_step(bool network_ready) {
    if(!device_http_configured() || !network_ready || voice_stream_busy()) return;
    uint32_t now=net_now_ms();
    if(wait_in_progress(now)) return;
    bool pending=false;
    if(baseline_known && paired_last) {
        report_t report=current_report();
        bool changed=!acked_valid || !same_report(&report,&acked);
        bool keepalive=acked_valid && (active(report.phase) || report.phase==AUDIO_ENROLL_SAVING) &&
            (uint32_t)(now-acked_at)>=KEEPALIVE_MS;
        pending=changed;
        bool same_as_failed=attempted_valid && same_report(&report,&attempted) && report_backoff;
        bool held=same_as_failed && (uint32_t)(now-report_at)<report_backoff;
        if((changed || keepalive) && !held) { if(send_report(&report,!changed)) return; }
    }
    if(poll_force || !polled || (uint32_t)(now-poll_at)>=poll_interval(pending)) poll();
}
