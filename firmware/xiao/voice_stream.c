#include "voice_stream.h"
#include "audio_app.h"
#include "audio_link.h"
#include "device_mode.h"
#include "net_state.h"
#include "playback.h"
#include "servo_control.h"
#include "timing.h"
#include "tune.h"
#include "voice_settings.h"
#include "voice_transport.h"
#include "voice_call_diag.h"
#include "xlog.h"
#include <limits.h>
#include <math.h>
#include <stdatomic.h>
#include <string.h>

typedef enum { STARTING, CONNECT_AGENT, WAIT_REPLY, PLAYING, WAIT_LISTEN, LISTEN_DELAY,
               LISTENING, ENDING, FINISHED } call_state_t;
typedef struct {
    voice_transport_t server;
    uint32_t session, turn, input_count, output_count, output_ack, listen_generation;
    uint32_t next_turn, input_report_count;
    bool output_ended, end_after_playback, may_have_answered, playback_reported, playback_start_marked;
    const char *io_failure;
    call_state_t state;
    uint32_t began, phase, last_server, last_ping, playback_done;
} call_t;
static call_t call;
static voice_call_diag_t call_diag,pending_call_diag;
static bool call_diag_pending;
static bool call_diag_greeting_seen;
static volatile bool busy, start_requested, stop_requested, recovery_required;
static volatile bool recovery_confirm_requested;
/* Only the voice task advances the timer; console callers can read it. */
static _Atomic bool cooldown_active;
static _Atomic uint32_t cooldown_began;
static volatile uint8_t probe_requested;
static void flush_call_diag(void) {
    if(!call_diag_pending || busy || !playback_idle())return;
    audio_link_acquire();if(audio_link()->voice_record_enabled)return;
    call_diag_pending=false; /* One storage attempt, including failure. */
    field_timing_save();
    if(!voice_call_diag_store(&pending_call_diag))xlog("[VOICE CALL] save_failed; previous record retained if available.\n");
}
/* Only the voice task owns recovery timers. An uncertain shared button always
 * remains locked for operator confirmation; distinct END may be retried. */
static uint32_t recovery_began, recovery_logged, recovery_delay_ms, recovery_attempts;
static bool recovery_log_seen, recovery_end_pending;
/* Legacy v1 starts greeting at READY, so keep its button-first order. */
#define VOICE_SERVER_FIRST (VOICE_RELAY_PROTOCOL!=1)
enum { PROBE_API=1, PROBE_SPEAKER, PROBE_LOOPBACK };

bool voice_stream_busy(void) { return busy; }
bool voice_stream_recovery_required(void) { return recovery_required || servo_recovery_required(); }
void voice_stream_confirm_recovery(void) {
    if(!busy && !servo_recovery_required() && !servo_motion_busy() && !servo_test_busy()) recovery_confirm_requested=true;
}
void voice_stream_request_call(void) {
    if (cooldown_active && (uint32_t)(net_now_ms()-cooldown_began)<VOICE_CHIME_COOLDOWN_MS)
        xlog("[VOICE] Call ignored during post-call cooldown.\n");
    else if (!voice_stream_recovery_required()) start_requested=true;
    else xlog("[VOICE] Recovery required; confirm the intercom is idle with @confirm before a new call.\n");
}
void voice_stream_request_stop(void) { stop_requested=true; }
void voice_stream_request_api_probe(void) { probe_requested=PROBE_API; }
void voice_stream_request_speaker_test(void) { probe_requested=PROBE_SPEAKER; }
void voice_stream_request_loopback(void) { probe_requested=PROBE_LOOPBACK; }
static bool control(uint8_t type, uint32_t turn, uint32_t sequence)
{
    voice_header_t h={.type=type,.session=call.session,.turn=turn,.sequence=sequence};
    return voice_transport_send(&call.server,&h,NULL);
}
static void phase(call_state_t state)
{ call.state=state; call.phase=net_now_ms(); }
static bool call_time_limit_reached(void)
{
    return call.may_have_answered &&
        (uint32_t)(net_now_ms()-call.began)>=VOICE_CALL_TIMEOUT_MS;
}
static void begin_call_cooldown(void)
{
    cooldown_began=net_now_ms(); cooldown_active=true;
    start_requested=false; /* A request posted during the call must not replay. */
    xlog("[VOICE] New calls inhibited for %lu ms after the button attempt.\n",
        (unsigned long)VOICE_CHIME_COOLDOWN_MS);
}
static void suppress_cooldown_requests(bool *detected)
{
    if (!cooldown_active) return;
    if ((uint32_t)(net_now_ms()-cooldown_began)>=VOICE_CHIME_COOLDOWN_MS) {
        cooldown_active=false;
        /* The event mailbox has no timestamp. Drop the last pending chime on
         * the expiry poll, so a cooldown event cannot replay after expiry. */
        *detected=false;
        xlog("[VOICE] Call cooldown complete; recovery state unchanged.\n");
        return;
    }
    *detected=false;
    start_requested=false; /* Chimes and manual requests are discarded, never queued. */
}
static bool relay(const voice_header_t *h)
{
    bool ok=voice_transport_send(&call.server,h,NULL);
    if (!ok) call.io_failure="server_send_failed";
    return ok;
}
static bool packet_session(const voice_packet_t *p)
{ return p->header.session==call.session; }

static bool server_packet(const voice_packet_t *p)
{
    const voice_header_t *h=&p->header;
    if (!packet_session(p)) return false;
    call.last_server=net_now_ms();
    if (h->type==VOICE_PING) return control(VOICE_PONG,h->turn,h->sequence);
    if (h->type==VOICE_PONG) return true;
    if (h->type==VOICE_ERROR) {
        xlog("[VOICE] Server rejected the session (see server log).\n"); return false;
    }
    if (h->type==VOICE_LISTEN) {
        if (call.state!=WAIT_LISTEN || call.end_after_playback || call.turn==UINT32_MAX || h->turn!=call.turn+1u) return false;
        call.next_turn=h->turn; phase(LISTEN_DELAY); return true;
    }
    if (h->turn!=call.turn) return false;
    switch (h->type) {
    case VOICE_OUTPUT_START:
        if (call.state!=WAIT_REPLY && !(voice_transport_legacy(&call.server) && call.state==LISTENING)) return false;
        if (voice_transport_legacy(&call.server)) {
            // LiveKit's VAD may respond before the endpoint's longer silence
            // boundary. Stop publishing input as soon as output arrives.
            audio_link()->voice_record_enabled=0; audio_link_release();
        }
        call.output_count=call.output_ack=0;
        call.output_ended=call.end_after_playback=call.playback_reported=call.playback_start_marked=false;
        timing_mark("reply_start",call.turn,net_now_ms());
        if (!playback_open(net_now_ms())) { call.io_failure="speaker_busy"; return false; }
        phase(PLAYING); xlog("[VOICE] Response %lu: recording paused, playing on speaker.\n",(unsigned long)call.turn);
        return true;
    case VOICE_OUTPUT_AUDIO:
        if (call.state!=PLAYING || call.output_ended || h->sequence!=call.output_count || call.output_count>=3000) return false;
        if (!playback_push(p->payload,h->length,net_now_ms())) { call.io_failure="audio_queue_full"; return false; }
        if(!call_diag_greeting_seen){call_diag.greeting_ms=net_now_ms();call_diag_greeting_seen=true;}
        ++call.output_count; return true;
    case VOICE_OUTPUT_END:
        if (call.state!=PLAYING || call.output_ended || !call.output_count || h->sequence!=call.output_count) return false;
        call.output_ended=true; call.end_after_playback=(h->flags&1)!=0;
        xlog("[VOICE] Output ended: %lu frames; waiting for playback completion.\n",(unsigned long)call.output_count);
        playback_finish();
        return true;
    case VOICE_NO_REPLY:
        if (call.state!=WAIT_REPLY) return false;
        xlog("[VOICE] No speech recognized for turn %lu; listening again.\n",(unsigned long)call.turn);
        phase(WAIT_LISTEN); return true;
    case VOICE_CALL_END:
        if (call.state!=WAIT_LISTEN && call.state!=WAIT_REPLY) return false;
        if (!servo_end_press()) { call.io_failure="end_button_failed"; return false; }
        timing_mark("end_press_requested",call.turn,net_now_ms());
        phase(ENDING); return true;
    default: return false;
    }
}
/* Acknowledge accepted PCM to the server and report real speaker completion. */
static bool playback_progress(void)
{
    if (call.state!=PLAYING) return true;
    uint32_t started=playback_started_ms();
    if (started && !call.playback_start_marked) {
        call.playback_start_marked=true;
        timing_mark("playback_start",call.turn,started);
    }
    const char *error=playback_error();
    if (error) { call.io_failure=error; return false; }
    uint32_t credit=playback_credit();
    if (credit>call.output_ack) {
        voice_header_t h={.type=VOICE_AUDIO_ACK,.session=call.session,.turn=call.turn,.sequence=credit};
        uint32_t previous_ack=call.output_ack;
        call.output_ack=credit;
        if (call.output_ack/50u != previous_ack/50u)
            xlog("[VOICE] Relay progress: sent=%lu ms acknowledged=%lu ms elapsed=%lu ms.\n",
                (unsigned long)(call.output_count*20u), (unsigned long)(call.output_ack*20u),
                (unsigned long)(net_now_ms()-call.phase));
        if (!relay(&h)) return false;
    }
    if (call.output_ended && playback_done()) {
        if (call.output_ack!=call.output_count) return false;
        voice_header_t h={.type=VOICE_PLAYBACK_DONE,.session=call.session,.turn=call.turn,.sequence=call.output_count};
        call.playback_done=net_now_ms();
        if (!relay(&h)) return false;
        xlog("[VOICE] Playback complete: turn %lu.\n",(unsigned long)call.turn);
        timing_mark("playback_done",call.turn,call.playback_done);
        phase(WAIT_LISTEN);
    }
    return true;
}
static bool await_ready(void)
{
    uint32_t start=net_now_ms();
    voice_packet_t p;
    while (!stop_requested && !call_time_limit_reached() && net_now_ms()-start<60000u) {
        int r=voice_transport_poll(&call.server,&p);
        if (r<0) return false;
        if (r>0) {
            if (!packet_session(&p)) return false;
            if (p.header.type==VOICE_READY) return p.header.turn==0;
            if (p.header.type!=VOICE_PING || !control(VOICE_PONG,p.header.turn,p.header.sequence)) return false;
        }
        net_sleep_ms(1);
    }
    return false;
}
static bool run_api_probe(uint32_t session)
{
    memset(&call,0,sizeof(call)); call.session=session;
    voice_transport_init(&call.server);
    call.server.diagnostic=true;
    bool ok=false, ready=false;
    const char *reason="connect_failed";
    xlog("[API WSS] checking; no call_started, microphone or buttons.\n");
    if (!voice_transport_server(&call.server)) goto done;
    reason="ready_failed";
    if (!control(VOICE_HELLO,0,0) || !await_ready()) goto done;
    ready=true;
    reason="pong_missing";
    if (!control(VOICE_PING,0,1)) goto done;
    uint32_t start=net_now_ms();
    voice_packet_t p;
    while (!stop_requested && net_now_ms()-start<5000u) {
        int r=voice_transport_poll(&call.server,&p);
        if (r<0) break;
        if (r>0) {
            ok=packet_session(&p) && p.header.type==VOICE_PONG && p.header.turn==0 && p.header.sequence==1;
            break;
        }
        net_sleep_ms(1);
    }
done:
    if (ready) (void)control(VOICE_CANCEL,0,0);
    if (ok) xlog("[API WSS] OK: TLS, API authorization, relay READY and PING/PONG; no conversation started.\n");
    else xlog("[API WSS] %s\n",reason);
    voice_transport_close(&call.server);
    return ok;
}
static bool await_call_started(void)
{
    /* Up to 30 s before the single press, 2 s holding and 3 s returning.
     * No agent session exists until the button has been released. */
    uint32_t start=net_now_ms(), last_ping=start;
    while (!stop_requested && net_voice_ready() && !call_time_limit_reached() && net_now_ms()-start<65000u) {
        servo_call_status_t status=servo_call_status();
        if (status==SERVO_CALL_FAILED || status==SERVO_CALL_MANUAL_CHECK_REQUIRED) return false;
        if (status==SERVO_CALL_STARTED) {
            phase(CONNECT_AGENT);
            xlog("[VOICE] Call button operation complete; now connecting voice agent.\n");
            return true;
        }
        if (VOICE_SERVER_FIRST) {
            /* The API session already exists: keep it alive and notice its loss. */
            voice_packet_t p;
            int r=voice_transport_poll(&call.server,&p);
            if (r<0) { call.io_failure="server_connection_lost"; return false; }
            if (r>0 && !server_packet(&p)) { call.io_failure="server_protocol_error"; return false; }
            if (net_now_ms()-last_ping>=5000u) {
                if (!control(VOICE_PING,0,0)) { call.io_failure="server_send_failed"; return false; }
                last_ping=net_now_ms();
            }
        }
        net_sleep_ms(1);
    }
    return false;
}
static bool pause_capture(bool active)
{
    volatile audio_link_t *s=audio_link();
    s->voice_call_active=active?1u:0u; audio_link_release();
    uint32_t start=net_now_ms();
    while (net_now_ms()-start<2000u) {
        audio_link_acquire();
        if (s->voice_call_ack==(active?1u:0u)) {
            audio_link_acquire();
            s->voice_read_seq=s->voice_write_seq; audio_link_release(); return true;
        }
        net_sleep_ms(5);
    }
    return false;
}
static bool begin_listen(void)
{
    volatile audio_link_t *s=audio_link();
    audio_link_acquire();
    if (voice_transport_legacy(&call.server)) {
        // Any frames still being published when LiveKit began its response
        // belong to the previous turn, not to the next microphone window.
        s->voice_read_seq=s->voice_write_seq; audio_link_release();
    }
    if (!s->voice_call_ack || s->voice_listen_seq==UINT32_MAX ||
        s->voice_write_seq!=s->voice_read_seq) return false;
    call.turn=call.next_turn; call.input_count=call.input_report_count=0;
    if (!control(VOICE_INPUT_START,call.turn,0)) return false;
    s->voice_listen_turn=call.turn;
    s->voice_rms_gate=tune_voice_gate();
    s->voice_record_enabled=1;
    audio_link_release(); call.listen_generation=++s->voice_listen_seq; audio_link_release();
    phase(LISTENING);
    xlog("[VOICE] Listening: turn %lu; max 30s / silence 1.2s.\n",(unsigned long)call.turn);
    timing_mark("listen_start",call.turn,net_now_ms());
    return true;
}
static bool capture_step(void)
{
    volatile audio_link_t *s=audio_link();
    audio_link_acquire();
    if (s->audio_status!=1) return false;
    if (s->voice_listen_ack!=call.listen_generation)
        return net_now_ms()-call.phase<2000u;
    uint32_t end_generation=s->voice_end_listen_seq;
    audio_link_acquire();
    if (end_generation==call.listen_generation && s->voice_end_reason>=3) {
        const char *reason=s->voice_end_reason==3?"send buffer overflow":
            s->voice_end_reason==4?"microphone capture gap":"cancelled";
        xlog("[VOICE] Capture aborted: %s (reason %lu); sent=%lu ms queued=%lu frames; incomplete turn discarded.\n",
            reason,(unsigned long)s->voice_end_reason,(unsigned long)(call.input_count*20u),
            (unsigned long)(s->voice_write_seq-s->voice_read_seq));
        return false;
    }
    /* Bounded catch-up pass: still service the server every iteration. */
    for (unsigned i=0;i<4;++i) {
        uint32_t write=s->voice_write_seq;
        audio_link_acquire();
        uint32_t read=s->voice_read_seq;
        if (write==read) break;
        if (write-read>AUDIO_LINK_RING_FRAMES || call.input_count>=1500) return false;
        uint8_t pcm[640];
        for (unsigned n=0;n<320;++n) {
            uint16_t sample=(uint16_t)s->voice_pcm[read%AUDIO_LINK_RING_FRAMES][n];
            pcm[n*2]=(uint8_t)sample; pcm[n*2+1]=(uint8_t)(sample>>8);
        }
        voice_header_t h={.type=VOICE_INPUT_AUDIO,.session=call.session,.turn=call.turn,
            .sequence=call.input_count,.length=sizeof(pcm)};
        if (!voice_transport_send(&call.server,&h,pcm)) {
            xlog("[VOICE] Microphone frame send failed: frame=%lu queued=%lu.\n",
                (unsigned long)call.input_count,(unsigned long)(s->voice_write_seq-s->voice_read_seq));
            return false;
        }
        if (!call.input_count) call.phase=net_now_ms();
        ++call.input_count;
        ++call_diag.input_frames;
        audio_link_release(); s->voice_read_seq=read+1u; audio_link_release();
        if (call.input_count==1u || call.input_count-call.input_report_count>=50u) {
            call.input_report_count=call.input_count;
            xlog("[VOICE] Input streaming: sent=%lu ms queued=%lu frames rms=%.0f.\n",
                (unsigned long)(call.input_count*20u),
                (unsigned long)(s->voice_write_seq-s->voice_read_seq),
                (double)s->last_rms);
        }
    }
    audio_link_acquire();
    if (s->voice_end_listen_seq==call.listen_generation) {
        audio_link_acquire();
        if (s->voice_end_reason!=1 && s->voice_end_reason!=2) return false;
        if (s->voice_read_seq==s->voice_end_seq) {
            if (!call.input_count || s->voice_end_turn!=call.turn || s->voice_samples!=call.input_count*320) return false;
            voice_header_t h={.type=VOICE_INPUT_END,.flags=s->voice_end_reason==2?1:0,
                .session=call.session,.turn=call.turn,.sequence=call.input_count};
            if (!voice_transport_send(&call.server,&h,NULL)) return false;
            call_diag.input_end_ms=net_now_ms();
            if(!voice_transport_legacy(&call.server))call_diag.input_end_sent=1;
            s->voice_record_enabled=0; audio_link_release();
            phase(WAIT_REPLY);
            timing_mark("speech_end",call.turn,net_now_ms());
            xlog("[VOICE] Input complete: %lu ms; recording paused.\n",(unsigned long)(call.input_count*20));
        }
    }
    return true;
}
static void stop_playback(void)
{
    playback_abort();
    uint32_t start=net_now_ms();
    while (!playback_idle() && net_now_ms()-start<500u) net_sleep_ms(2);
}
static bool end_on_error(void)
{
    stop_playback();
    (void)control(VOICE_CANCEL,call.turn,0);
    if (!call.may_have_answered) return true;
    servo_call_cancel();
    uint32_t start=net_now_ms();
    while (net_now_ms()-start<65000u) {
        servo_call_status_t status=servo_call_status();
        if (status==SERVO_CALL_ENDED) return true;
        if (status==SERVO_CALL_FAILED || status==SERVO_CALL_MANUAL_CHECK_REQUIRED) return false;
        net_sleep_ms(5);
    }
    return false;
}
static bool connect_server(const char **reason)
{
    *reason="server_connect_failed";
    if (!voice_transport_server(&call.server)) return false;
    *reason="server_ready_failed";
    if (!control(VOICE_HELLO,0,0) || !await_ready()) return false;
    xlog("[VOICE] Server ready: /api/relay protocol %u.\n",voice_transport_legacy(&call.server)?1u:2u);
    timing_mark("relay_ready",0,net_now_ms());
    return true;
}
static void enter_recovery(bool end_pending)
{
    recovery_began=net_now_ms(); recovery_delay_ms=VOICE_RECOVERY_RETRY_MIN_MS;
    recovery_attempts=0; recovery_log_seen=false;
    recovery_end_pending=end_pending;
    recovery_required=true;
}
static bool run_call(uint32_t session)
{
    memset(&call,0,sizeof(call)); call.session=session; voice_transport_init(&call.server);
    memset(&call_diag,0,sizeof(call_diag));
    call_diag_greeting_seen=false;
    bool success=false, release=false, opened=false, button_attempted=false;
    const char *reason="capture_pause_failed";
    timing_mark("call_start",0,net_now_ms());
    xlog("[VOICE] Preparing streaming call.\n");
    if (!pause_capture(true)) goto cleanup;
    /* Without valid settings no call can follow: leave the intercom alone instead of answering and hanging up. */
    reason="api_settings_missing";
    if (!voice_transport_configured()) {
        xlog("[VOICE] API settings missing/invalid: call button not pressed.\n");
        goto cleanup;
    }
    /* Complete the physical button operation before starting an agent. */
    reason="servo_busy";
    if (!servo_call_open()) goto cleanup;
    opened=true;
    if (stop_requested) goto cleanup;
    if (VOICE_SERVER_FIRST) {
        if (!connect_server(&reason)) {
            if (!stop_requested) xlog("[VOICE] API unreachable (%s); intercom button not pressed.\n",reason);
            goto cleanup;
        }
        if (stop_requested || !net_voice_ready()) goto cleanup;
    }
    phase(STARTING); call.began=call.last_server=call.last_ping=net_now_ms();
    call_diag.started_ms=call.began;
    call.may_have_answered=button_attempted=true;
    reason="call_button_failed";
    if (!servo_call_press()) goto cleanup;
    timing_mark("call_press_requested",0,net_now_ms());
    xlog("[VOICE] Waiting for one call-button press and release; voice agent not started.\n");
    if (!await_call_started() || stop_requested) {
        if (call.io_failure) reason=call.io_failure;
        goto cleanup;
    }
    if (!VOICE_SERVER_FIRST && !connect_server(&reason)) goto cleanup;
    reason="agent_start_failed";
    if (stop_requested || call_time_limit_reached() || !control(VOICE_CALL_START,0,0)) goto cleanup;
    phase(WAIT_REPLY);
    call.last_server=call.last_ping=net_now_ms();
    while (!stop_requested && net_voice_ready()) {
        /* Check before accepting more PCM or starting another microphone turn. */
        if (call_time_limit_reached()) { reason="device_time_limit"; break; }
        if (call.state==ENDING) {
            servo_call_status_t status=servo_call_status();
            if (status==SERVO_CALL_FAILED || status==SERVO_CALL_MANUAL_CHECK_REQUIRED) { reason="end_button_failed"; break; }
            if (status==SERVO_CALL_ENDED) {
                voice_header_t h={.type=VOICE_CALL_ENDED,.session=call.session,.turn=call.turn};
                /* A server disconnect after receiving its final ACK is harmless. */
                (void)relay(&h); call.may_have_answered=false; phase(FINISHED);
                reason="completed"; success=true; break;
            }
        }
        bool server_failed=false;
        voice_packet_t p;
        // Drain a bounded burst, then return to playback credit and capture.
        // A full queue leaves PCM in TCP, propagating backpressure to the server.
        for (unsigned packet=0;packet<4 && !playback_full();++packet) {
            int r=voice_transport_poll(&call.server,&p);
            if (r<0) { reason="server_connection_lost"; server_failed=true; break; }
            if (!r) break;
            if (!server_packet(&p)) { reason=call.io_failure?call.io_failure:"server_protocol_error"; server_failed=true; break; }
        }
        if (server_failed) break;
        if (!playback_progress()) { reason=call.io_failure?call.io_failure:"playback_failed"; break; }
        uint32_t now=net_now_ms();
        if (call.state==LISTEN_DELAY && now-call.playback_done>=VOICE_SETTLE_MS)
            if (!begin_listen()) { reason="microphone_start_failed"; break; }
        if (call.state==LISTENING && !capture_step()) { reason="microphone_or_send_failed"; break; }
        now=net_now_ms();
        if (call_time_limit_reached()) { reason="device_time_limit"; break; }
        if (now-call.phase>(call.state==LISTENING?VOICE_IDLE_TIMEOUT_MS:VOICE_RESPONSE_TIMEOUT_MS)) {
            reason=call.state==LISTENING?"speech_wait_timeout":"response_timeout"; break;
        }
        if (!voice_transport_legacy(&call.server) && now-call.last_server>15000u) {
            reason="server_keepalive_timeout"; break;
        }
        if (now-call.last_ping>=5000u) {
            if (!control(VOICE_PING,call.turn,0)) { reason="keepalive_send_failed"; break; }
            call.last_ping=now;
        }
        net_sleep_ms(1);
    }
cleanup:
    if (stop_requested) reason="manual_stop";
    else if (!net_voice_ready() && !success) reason="network_lost";
    else if (!success && call_time_limit_reached()) reason="device_time_limit";
    call_diag.reason=voice_call_diag_reason(reason);call_diag.phase=(uint32_t)call.state;
    call_diag.turn=call.turn;call_diag.ended_ms=net_now_ms();
    pending_call_diag=call_diag;call_diag_pending=true;
    timing_mark("call_end",call.turn,net_now_ms());
    xlog("[VOICE] Call ending: reason=%s state=%u turn=%lu input_ms=%lu.\n",
        reason,(unsigned)call.state,(unsigned long)call.turn,(unsigned long)(call.input_count*20u));
    audio_link()->voice_record_enabled=0; audio_link_release();
    release=success || end_on_error();
    voice_transport_close(&call.server);
    if (opened) servo_call_close();
    /* Failures and uncertain ENDs also inhibit repeated attempts. Diagnostics
     * remain usable; recovery_required is an independent, stronger restriction. */
    if (button_attempted) begin_call_cooldown();
    if (release && pause_capture(false)) {
        xlog("[VOICE] %s; chime detection rearmed.\n",success?"Call ended":"Call stopped");
        return true;
    }
    /* Retry only a distinct END output. The servo's shared-button interlock
     * remains stronger and can only be cleared by an operator's @confirm. */
    enter_recovery(!release);
    busy=false; // Closed transports are free for diagnostics; new calls remain inhibited.
    xlog("[VOICE] Playback/call state uncertain. Recording remains paused. Separate END recovery retries automatically; shared buttons require idle confirmation with @confirm. Diagnostics available.\n");
    return false;
}
/* A fresh servo ownership that presses END only, and only while the earlier END is
 * unconfirmed and the owned configuration has a distinct END. servo_call_open
 * refuses while a servo is moving or held by a test, so a busy servo means "try later". It never presses CALL and never starts an
 * agent; with nothing owed it only retries re-arming the microphone. */
static bool run_recovery(const char **reason)
{
    bool ok=true, opened=false;
    *reason="manual_check_required";
    if (servo_recovery_required() || servo_motion_busy() || servo_test_busy()) return false;
    if (recovery_end_pending) {
        ok=false;
        *reason="servo_busy";
        if (!servo_call_open()) goto done;
        opened=true;
        /* Ownership prevents mapping changes between this check and END. A
         * shared toggle cannot prove whether another press would start a call. */
        servo_pusher_config_t pushers;
        *reason="manual_check_required";
        if (!servo_pusher_get(&pushers) || pushers.call_start==pushers.call_end) goto done;
        *reason="end_button_failed";
        if (!servo_end_press()) goto done;
        *reason="end_unconfirmed";
        uint32_t start=net_now_ms();
        while (!stop_requested && net_now_ms()-start<VOICE_RECOVERY_CONFIRM_MS) {
            servo_call_status_t status=servo_call_status();
            if (status==SERVO_CALL_ENDED) { ok=true; recovery_end_pending=false; break; }
            if (status==SERVO_CALL_FAILED || status==SERVO_CALL_MANUAL_CHECK_REQUIRED) break;
            net_sleep_ms(5);
        }
        if (stop_requested) *reason="manual_stop";
    }
done:
    if (opened) servo_call_close();
    if (ok) {
        *reason="capture_rearm_failed";
        ok=pause_capture(false);
    }
    return ok;
}
/* Called by the voice task only when idle. Never overlaps a call or diagnostic. */
static void recovery_step(void)
{
    if (!recovery_required || busy) return;
    uint32_t now=net_now_ms();
    if (now-recovery_began<recovery_delay_ms) return;
    stop_requested=false; busy=true;
    ++recovery_attempts;
    const char *reason="";
    bool cleared=run_recovery(&reason);
    busy=false;
    now=net_now_ms();
    if (cleared) {
        recovery_required=false;
        xlog("[VOICE] Call stopped; chime detection rearmed (END operation confirmed after %lu recovery attempt(s)).\n",
            (unsigned long)recovery_attempts);
        return;
    }
    recovery_began=now;
    if (recovery_delay_ms<VOICE_RECOVERY_RETRY_MAX_MS) {
        recovery_delay_ms*=2u;
        if (recovery_delay_ms>VOICE_RECOVERY_RETRY_MAX_MS) recovery_delay_ms=VOICE_RECOVERY_RETRY_MAX_MS;
    }
    if (!recovery_log_seen || now-recovery_logged>=VOICE_RECOVERY_LOG_MS) {
        recovery_log_seen=true; recovery_logged=now;
        xlog("[VOICE] Intercom state still uncertain (attempt %lu: %s). Recording remains paused; retry in %lu s.\n",
            (unsigned long)recovery_attempts,reason,(unsigned long)(recovery_delay_ms/1000u));
    }
}
/* Waits with backpressure; only false if the speaker failed. */
static bool push_frame(const int16_t *pcm, uint32_t samples, uint32_t start)
{
    while (!playback_push((const uint8_t *)pcm,samples*2u,net_now_ms())) {
        if (playback_error() || net_now_ms()-start>30000u) { stop_playback(); return false; }
        net_sleep_ms(2);
    }
    return true;
}
static bool finish_playback(uint32_t start)
{
    playback_finish();
    while (!playback_done()) {
        if (playback_error() || net_now_ms()-start>30000u) { stop_playback(); return false; }
        net_sleep_ms(5);
    }
    return true;
}
static bool play_samples(const int16_t *pcm, uint32_t samples)
{
    uint32_t start=net_now_ms();
    if (!playback_open(start)) return false;
    for (uint32_t offset=0;offset<samples;) {
        uint32_t n=samples-offset; if (n>PLAYBACK_FRAME_SAMPLES) n=PLAYBACK_FRAME_SAMPLES;
        if (!push_frame(pcm+offset,n,start)) return false;
        offset+=n;
    }
    return finish_playback(start);
}
static bool play_tone(void)
{
    uint32_t start=net_now_ms();
    if (!playback_open(start)) return false;
    int16_t frame[PLAYBACK_FRAME_SAMPLES];
    for (unsigned f=0;f<AUDIO_RATE/PLAYBACK_FRAME_SAMPLES;++f) {
        for (unsigned i=0;i<PLAYBACK_FRAME_SAMPLES;++i)
            frame[i]=(int16_t)lrintf(12000.0f*sinf(2.0f*3.14159265f*1000.0f*(float)(f*PLAYBACK_FRAME_SAMPLES+i)/(float)AUDIO_RATE));
        if (!push_frame(frame,PLAYBACK_FRAME_SAMPLES,start)) return false;
    }
    return finish_playback(start);
}
static void run_speaker_test(void)
{
    /* The tone must not be heard as a chime, so the microphone is parked. */
    if (!pause_capture(true)) { xlog("[DIAG] speaker ok=0 capture_pause_failed\n"); return; }
    xlog("[DIAG] speaker playing\n");
    bool ok=play_tone();
    if (ok) xlog("[DIAG] speaker ok=1\n");
    else xlog("[DIAG] speaker ok=0 %s\n",playback_error()?playback_error():"playback_timeout");
    (void)pause_capture(false);
}
static void run_loopback(void)
{
    volatile audio_link_t *s=audio_link();
    s->loopback_failed=0u; audio_link_release();
    if (!audio_app_post_command('l')) { xlog("[DIAG] loopback busy\n"); return; }
    uint32_t start=net_now_ms();
    for (;;) {
        audio_link_acquire();
        if (s->loopback_samples) break;
        if (s->loopback_failed==2u) { xlog("[DIAG] loopback ok=0 microphone_failed\n"); return; }
        if (s->loopback_failed) { xlog("[DIAG] loopback busy\n"); return; }
        if (net_now_ms()-start>5000u) { xlog("[DIAG] loopback ok=0 microphone_timeout\n"); return; }
        net_sleep_ms(10);
    }
    uint32_t samples=s->loopback_samples;
    bool ok=pause_capture(true);
    if (ok) {
        xlog("[DIAG] loopback playing\n");
        ok=play_samples(audio_jobs.pending_pcm,samples);
    }
    audio_app_loopback_release();
    if (ok) xlog("[DIAG] loopback ok=1\n");
    else xlog("[DIAG] loopback ok=0 %s\n",playback_error()?playback_error():"playback_timeout");
    (void)pause_capture(false);
}
void voice_stream_task(void *argument)
{
    (void)argument;
    uint32_t observed=0;
    bool available_before=false;
    for (;;) {
        flush_call_diag();
        volatile audio_link_t *s=audio_link();
        bool available=VOICE_STREAM_ENABLED && net_voice_ready();
        audio_link_acquire();
        uint32_t event=s->event_seq;
        bool detected=false;
        if (event!=observed) {
            observed=event; detected=event && available && available_before;
        }
        if (recovery_confirm_requested && !busy && !servo_recovery_required() && !servo_motion_busy() && !servo_test_busy()) {
            recovery_confirm_requested=false;
            if(!recovery_required || pause_capture(false)) {
                recovery_required=false; recovery_end_pending=false; start_requested=false;
                detected=false; observed=s->event_seq;
                xlog("[VOICE] Operator confirmed idle; chime detection rearmed.\n");
            }
        }
        suppress_cooldown_requests(&detected);
        if (voice_stream_recovery_required()) detected=false;
        bool manual=!voice_stream_recovery_required() && start_requested; start_requested=false;
        /* Stop mode answers nothing: chimes and manual requests are dropped, not queued. */
        detected=device_mode_gate_call(detected);
        manual=device_mode_gate_call(manual);
        uint8_t diagnostic=probe_requested; probe_requested=0;
        if ((detected || manual || diagnostic) && !busy) {
            bool local=diagnostic==PROBE_SPEAKER || diagnostic==PROBE_LOOPBACK;
            bool ready=local && !detected && !manual ? !voice_stream_recovery_required() : available;
            if (!ready) {
                if (diagnostic==PROBE_API) xlog("[API WSS] network_not_ready\n");
                else if (local) xlog(diagnostic==PROBE_SPEAKER?"[DIAG] speaker busy\n":"[DIAG] loopback busy\n");
                else xlog("[VOICE] Wi-Fi, clock or API configuration not ready.\n");
            } else {
                uint32_t session=0;
                while (!session) net_random(&session,sizeof(session));
                stop_requested=false; busy=true;
                if (detected || manual) {
                    if (run_call(session)) busy=false;
                    observed=s->event_seq; available_before=false;
                } else {
                    if (diagnostic==PROBE_API) (void)run_api_probe(session);
                    else if (diagnostic==PROBE_SPEAKER) run_speaker_test();
                    else run_loopback();
                    busy=false;
                }
            }
        } else if (diagnostic && busy) {
            xlog(diagnostic==PROBE_API?"[API WSS] busy\n":diagnostic==PROBE_SPEAKER?"[DIAG] speaker busy\n":"[DIAG] loopback busy\n");
        } else if (recovery_required) recovery_step();
        available_before=available;
        net_sleep_ms(50);
    }
}
