#include "voice_stream.h"
#include "voice_transport.h"
#include "voice_settings.h"
#include "e84_network.h"
#include "e84_shared.h"
#include "m5_settings.h"
#include "m5_link.h"
#include "cy_wcm.h"
#include <stdio.h>
#include <string.h>
#include <limits.h>

typedef enum { STARTING, CONNECT_AGENT, WAIT_REPLY, PLAYING, WAIT_LISTEN, LISTEN_DELAY,
               LISTENING, ENDING, FINISHED } call_state_t;
typedef struct {
    voice_transport_t server, m5;
    uint32_t session, turn, input_count, output_count, output_ack, listen_generation;
    uint32_t next_turn, input_report_count;
    bool output_ended, end_after_playback, may_have_answered;
    call_state_t state;
    TickType_t began, phase, last_m5, last_server, last_ping, playback_done;
} call_t;
static call_t call;
static volatile bool busy, start_requested, stop_requested;

bool voice_stream_busy(void) { return busy; }
void voice_stream_request_call(void) { start_requested=true; }
void voice_stream_request_stop(void) { stop_requested=true; }
static bool control(voice_transport_t *l, uint8_t type, uint32_t turn, uint32_t sequence)
{
    voice_header_t h={.type=type,.session=call.session,.turn=turn,.sequence=sequence};
    return voice_transport_send(l,&h,NULL);
}
static void phase(call_state_t state)
{ call.state=state; call.phase=xTaskGetTickCount(); }
static bool relay(voice_transport_t *l, const voice_packet_t *p)
{ return voice_transport_send(l,&p->header,p->payload); }
static bool packet_session(const voice_packet_t *p)
{ return p->header.session==call.session; }

static bool server_packet(const voice_packet_t *p)
{
    const voice_header_t *h=&p->header;
    if (!packet_session(p)) return false;
    call.last_server=xTaskGetTickCount();
    if (h->type==VOICE_PING) return control(&call.server,VOICE_PONG,h->turn,h->sequence);
    if (h->type==VOICE_PONG) return true;
    if (h->type==VOICE_ERROR) {
        printf("[VOICE] Server rejected the session (see server log).\n"); return false;
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
            e84_shared()->voice_record_enabled=0; e84_shared_release();
        }
        call.output_count=call.output_ack=0;
        call.output_ended=call.end_after_playback=false;
        if (!relay(&call.m5,p)) return false;
        phase(PLAYING); printf("[VOICE] Response %lu: recording paused, playing on M5.\n",(unsigned long)call.turn);
        return true;
    case VOICE_OUTPUT_AUDIO:
        if (call.state!=PLAYING || call.output_ended || h->sequence!=call.output_count || call.output_count>=3000) return false;
        if (!relay(&call.m5,p)) return false;
        ++call.output_count; return true;
    case VOICE_OUTPUT_END:
        if (call.state!=PLAYING || call.output_ended || !call.output_count || h->sequence!=call.output_count) return false;
        call.output_ended=true; call.end_after_playback=(h->flags&1)!=0;
        printf("[VOICE] Output ended: %lu frames; waiting for M5 playback completion.\n",(unsigned long)call.output_count);
        return relay(&call.m5,p);
    case VOICE_NO_REPLY:
        if (call.state!=WAIT_REPLY) return false;
        phase(WAIT_LISTEN); return true;
    case VOICE_CALL_END:
        if (call.state!=WAIT_LISTEN && call.state!=WAIT_REPLY) return false;
        if (!relay(&call.m5,p)) return false;
        phase(ENDING); return true;
    default: return false;
    }
}
static bool m5_packet(const voice_packet_t *p)
{
    const voice_header_t *h=&p->header;
    if (!packet_session(p)) return false;
    call.last_m5=xTaskGetTickCount();
    if (h->type==VOICE_PING) return control(&call.m5,VOICE_PONG,h->turn,h->sequence);
    if (h->type==VOICE_PONG) return true;
    if (h->type==VOICE_ERROR) {
        printf("[VOICE] M5 rejected the operation; check its display and servo configuration.\n"); return false;
    }
    if (h->turn!=call.turn) return false;
    switch (h->type) {
    case VOICE_CALL_STARTED:
        if (call.state!=STARTING || h->turn) return false;
        phase(CONNECT_AGENT);
        printf("[VOICE] Call button operation complete; now connecting voice agent.\n"); return true;
    case VOICE_AUDIO_ACK:
        if (call.state!=PLAYING || h->sequence<=call.output_ack || h->sequence>call.output_count) return false;
        call.output_ack=h->sequence;
        return relay(&call.server,p);
    case VOICE_PLAYBACK_DONE:
        if (call.state!=PLAYING || !call.output_ended || h->sequence!=call.output_count ||
            call.output_ack!=call.output_count) return false;
        call.playback_done=xTaskGetTickCount();
        if (!relay(&call.server,p)) return false;
        printf("[VOICE] M5 playback complete: turn %lu.\n",(unsigned long)call.turn);
        phase(WAIT_LISTEN); return true;
    case VOICE_CALL_ENDED:
        if (call.state!=ENDING) return false;
        /* A server disconnect after receiving its final ACK is harmless. */
        (void)relay(&call.server,p); call.may_have_answered=false; phase(FINISHED); return true;
    default: return false;
    }
}
static bool await_ready(voice_transport_t *l)
{
    TickType_t start=xTaskGetTickCount();
    voice_packet_t p;
    while (!stop_requested && xTaskGetTickCount()-start<pdMS_TO_TICKS(l->websocket?60000:10000)) {
        int r=voice_transport_poll(l,&p);
        if (r<0) return false;
        if (r>0) {
            if (!packet_session(&p)) return false;
            if (p.header.type==VOICE_READY) return p.header.turn==0;
            if (p.header.type!=VOICE_PING || !control(l,VOICE_PONG,p.header.turn,p.header.sequence)) return false;
        }
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return false;
}
static bool check_m5_alive(void)
{
    if (!control(&call.m5,VOICE_PING,0,1)) return false;
    TickType_t start=xTaskGetTickCount();
    voice_packet_t p;
    while (!stop_requested && xTaskGetTickCount()-start<pdMS_TO_TICKS(5000)) {
        int r=voice_transport_poll(&call.m5,&p);
        if (r<0) return false;
        if (r>0) return packet_session(&p) && p.header.type==VOICE_PONG &&
            p.header.turn==0 && p.header.sequence==1;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return false;
}
static bool await_call_started(void)
{
    /* M5 allows up to 30 s before its single press, 2 s holding and 3 s
     * returning. No agent session exists until it acknowledges release. */
    TickType_t start=xTaskGetTickCount(), last_ping=start;
    while (!stop_requested && e84_network_voice_ready() &&
           xTaskGetTickCount()-start<pdMS_TO_TICKS(65000)) {
        voice_packet_t p;
        int r=voice_transport_poll(&call.m5,&p);
        if (r<0 || (r>0 && !m5_packet(&p))) return false;
        if (call.state==CONNECT_AGENT) return true;
        if (xTaskGetTickCount()-last_ping>=pdMS_TO_TICKS(5000)) {
            if (!control(&call.m5,VOICE_PING,0,0)) return false;
            last_ping=xTaskGetTickCount();
        }
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return false;
}
static bool pause_capture(bool active)
{
    volatile e84_shared_t *s=e84_shared();
    s->voice_call_active=active?1u:0u; e84_shared_release();
    TickType_t start=xTaskGetTickCount();
    while (xTaskGetTickCount()-start<pdMS_TO_TICKS(2000)) {
        e84_shared_acquire();
        if (s->voice_call_ack==(active?1u:0u)) {
            e84_shared_acquire();
            s->voice_read_seq=s->voice_write_seq; e84_shared_release(); return true;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return false;
}
static bool begin_listen(void)
{
    volatile e84_shared_t *s=e84_shared();
    e84_shared_acquire();
    if (voice_transport_legacy(&call.server)) {
        // Any frames still being published when LiveKit began its response
        // belong to the previous turn, not to the next microphone window.
        s->voice_read_seq=s->voice_write_seq; e84_shared_release();
    }
    if (!s->voice_call_ack || s->voice_listen_seq==UINT32_MAX ||
        s->voice_write_seq!=s->voice_read_seq) return false;
    call.turn=call.next_turn; call.input_count=call.input_report_count=0;
    if (!control(&call.server,VOICE_INPUT_START,call.turn,0)) return false;
    s->voice_listen_turn=call.turn;
    s->voice_rms_gate=VOICE_RMS_GATE;
    s->voice_record_enabled=1;
    e84_shared_release(); call.listen_generation=++s->voice_listen_seq; e84_shared_release();
    phase(LISTENING);
    printf("[VOICE] Listening: turn %lu; max 30s / silence 1.2s.\n",(unsigned long)call.turn);
    return true;
}
static bool capture_step(void)
{
    volatile e84_shared_t *s=e84_shared();
    e84_shared_acquire();
    if (s->audio_status!=1) return false;
    if (s->voice_listen_ack!=call.listen_generation)
        return xTaskGetTickCount()-call.phase<pdMS_TO_TICKS(2000);
    uint32_t end_generation=s->voice_end_listen_seq;
    e84_shared_acquire();
    if (end_generation==call.listen_generation && s->voice_end_reason>=3) {
        const char *reason=s->voice_end_reason==3?"send buffer overflow":
            s->voice_end_reason==4?"microphone capture gap":"cancelled";
        printf("[VOICE] Capture aborted: %s (reason %lu); sent=%lu ms queued=%lu frames; incomplete turn discarded.\n",
            reason,(unsigned long)s->voice_end_reason,(unsigned long)(call.input_count*20u),
            (unsigned long)(s->voice_write_seq-s->voice_read_seq));
        return false;
    }
    /* Bounded catch-up pass: still service both network peers every iteration. */
    for (unsigned i=0;i<4;++i) {
        uint32_t write=s->voice_write_seq;
        e84_shared_acquire();
        uint32_t read=s->voice_read_seq;
        if (write==read) break;
        if (write-read>E84_VOICE_RING_FRAMES || call.input_count>=1500) return false;
        uint8_t pcm[640];
        for (unsigned n=0;n<320;++n) {
            uint16_t sample=(uint16_t)s->voice_pcm[read%E84_VOICE_RING_FRAMES][n];
            pcm[n*2]=(uint8_t)sample; pcm[n*2+1]=(uint8_t)(sample>>8);
        }
        voice_header_t h={.type=VOICE_INPUT_AUDIO,.session=call.session,.turn=call.turn,
            .sequence=call.input_count,.length=sizeof(pcm)};
        if (!voice_transport_send(&call.server,&h,pcm)) return false;
        if (!call.input_count) call.phase=xTaskGetTickCount();
        ++call.input_count;
        e84_shared_release(); s->voice_read_seq=read+1u; e84_shared_release();
        if (call.input_count==1u || call.input_count-call.input_report_count>=50u) {
            call.input_report_count=call.input_count;
            printf("[VOICE] Input streaming: sent=%lu ms queued=%lu frames rms=%lu.\n",
                (unsigned long)(call.input_count*20u),
                (unsigned long)(s->voice_write_seq-s->voice_read_seq),
                (unsigned long)s->last_rms);
        }
    }
    e84_shared_acquire();
    if (s->voice_end_listen_seq==call.listen_generation) {
        e84_shared_acquire();
        if (s->voice_end_reason!=1 && s->voice_end_reason!=2) return false;
        if (s->voice_read_seq==s->voice_end_seq) {
            if (!call.input_count || s->voice_end_turn!=call.turn || s->voice_samples!=call.input_count*320) return false;
            voice_header_t h={.type=VOICE_INPUT_END,.flags=s->voice_end_reason==2?1:0,
                .session=call.session,.turn=call.turn,.sequence=call.input_count};
            if (!voice_transport_send(&call.server,&h,NULL)) return false;
            s->voice_record_enabled=0; e84_shared_release();
            phase(WAIT_REPLY);
            printf("[VOICE] Input complete: %lu ms; recording paused.\n",(unsigned long)(call.input_count*20));
        }
    }
    return true;
}
static bool end_on_error(void)
{
    (void)control(&call.server,VOICE_CANCEL,call.turn,0);
    bool submitted=control(&call.m5,VOICE_CANCEL,call.turn,0);
    if (!call.may_have_answered) return true;
    if (!submitted) return false;
    TickType_t start=xTaskGetTickCount();
    voice_packet_t p;
    while (xTaskGetTickCount()-start<pdMS_TO_TICKS(65000)) {
        int r=voice_transport_poll(&call.m5,&p);
        if (r<0) break;
        if (r>0 && packet_session(&p)) {
            if (p.header.type==VOICE_CALL_ENDED && p.header.turn==call.turn) return true;
            if (p.header.type==VOICE_ERROR) return false;
        }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return false;
}
static bool run_call(uint32_t session)
{
    memset(&call,0,sizeof(call)); call.session=session; voice_transport_init(&call.server); voice_transport_init(&call.m5);
    bool success=false, release=false;
    printf("[VOICE] Preparing streaming call.\n");
    if (!pause_capture(true)) goto cleanup;
    /* Complete the physical button operation before starting an agent. */
    if (!voice_transport_m5(&call.m5)) goto cleanup;
    voice_header_t hello={.type=VOICE_HELLO,.session=session,.length=strlen(M5_TOKEN)};
    if (!voice_transport_send(&call.m5,&hello,M5_TOKEN) || !await_ready(&call.m5)) goto cleanup;
    if (!check_m5_alive() || stop_requested) goto cleanup;
    phase(STARTING); call.began=call.last_server=call.last_m5=call.last_ping=xTaskGetTickCount();
    call.may_have_answered=true;
    if (!control(&call.m5,VOICE_CALL_START,0,0)) goto cleanup;
    printf("[VOICE] Waiting for one call-button press and release; voice agent not started.\n");
    if (!await_call_started() || stop_requested) goto cleanup;
    if (!voice_transport_server(&call.server) || !control(&call.server,VOICE_HELLO,0,0) || !await_ready(&call.server)) goto cleanup;
    printf("[VOICE] Server ready: /api/relay protocol %u.\n",voice_transport_legacy(&call.server)?1u:2u);
    if (stop_requested || !control(&call.server,VOICE_CALL_START,0,0)) goto cleanup;
    phase(WAIT_REPLY);
    call.last_server=call.last_m5=call.last_ping=xTaskGetTickCount();
    while (!stop_requested && e84_network_voice_ready()) {
        voice_packet_t p;
        int r=voice_transport_poll(&call.m5,&p);
        if (r<0 || (r>0 && !m5_packet(&p))) break;
        if (call.state==FINISHED) { success=true; break; }
        r=voice_transport_poll(&call.server,&p);
        if (r<0 || (r>0 && !server_packet(&p))) break;
        TickType_t now=xTaskGetTickCount();
        if (call.state==LISTEN_DELAY && now-call.playback_done>=pdMS_TO_TICKS(VOICE_SETTLE_MS))
            if (!begin_listen()) break;
        if (call.state==LISTENING && !capture_step()) break;
        now=xTaskGetTickCount();
        if (now-call.began>pdMS_TO_TICKS(VOICE_CALL_TIMEOUT_MS) ||
            now-call.phase>pdMS_TO_TICKS(call.state==LISTENING?VOICE_IDLE_TIMEOUT_MS:VOICE_RESPONSE_TIMEOUT_MS) ||
            now-call.last_m5>pdMS_TO_TICKS(15000) ||
            (!voice_transport_legacy(&call.server) && now-call.last_server>pdMS_TO_TICKS(15000))) break;
        if (now-call.last_ping>=pdMS_TO_TICKS(5000)) {
            if (!control(&call.m5,VOICE_PING,call.turn,0) || !control(&call.server,VOICE_PING,call.turn,0)) break;
            call.last_ping=now;
        }
        vTaskDelay(pdMS_TO_TICKS(1));
    }
cleanup:
    e84_shared()->voice_record_enabled=0; e84_shared_release();
    release=success || end_on_error();
    voice_transport_close(&call.server); voice_transport_close(&call.m5);
    if (release && pause_capture(false)) {
        printf("[VOICE] %s; chime detection rearmed.\n",success?"Call ended":"Call stopped");
        return true;
    }
    /* Cannot prove that M5 stopped: hold capture muted until both boards are reset. */
    printf("[VOICE] Playback/call state uncertain. Recording remains paused. Check intercom and reset both boards.\n");
    return false;
}
void voice_stream_task(void *argument)
{
    (void)argument;
    uint32_t observed=0, counter=0;
    bool available_before=false;
    for (;;) {
        volatile e84_shared_t *s=e84_shared();
        bool available=VOICE_STREAM_ENABLED && e84_network_voice_ready() && m5_link_configured() && s->seed_ready;
        uint32_t guard=s->event_guard; e84_shared_acquire();
        uint32_t event=s->event_seq; e84_shared_acquire();
        bool detected=false;
        if (!(guard&1) && guard==s->event_guard && event!=observed) {
            observed=event; detected=event && available && available_before;
        }
        bool manual=start_requested; start_requested=false;
        if ((detected || manual) && !busy) {
            if (!available) printf("[VOICE] Wi-Fi, clock, API or M5 configuration not ready.\n");
            else if (counter==UINT32_MAX) printf("[VOICE] Session ID limit reached; reset required.\n");
            else {
                uint32_t session=s->seed[0]^(++counter);
                if (!session) {
                    if (counter==UINT32_MAX) continue;
                    session=s->seed[0]^(++counter);
                }
                stop_requested=false; busy=true;
                if (run_call(session)) busy=false;
                observed=s->event_seq; available_before=false;
            }
        }
        available_before=available;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
