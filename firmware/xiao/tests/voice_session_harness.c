#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include "voice_stream.c"
static unsigned diag_stores;
static bool diag_store_ok=true;
static voice_call_diag_t stored_diag;
uint32_t voice_call_diag_reason(const char *reason) {
    if(!strcmp(reason,"device_time_limit"))return 19u;
    if(!strcmp(reason,"completed"))return 2u;
    return 1u;
}
bool voice_call_diag_store(const voice_call_diag_t *value) {
    assert(!busy && playback_idle() && !audio_link()->voice_record_enabled);
    stored_diag=*value;++diag_stores;return diag_store_ok;
}

#define EXPECT_API_FIRST (VOICE_RELAY_PROTOCOL != 1)

static audio_link_t mailbox;
audio_jobs_t audio_jobs;
static uint32_t tick;
static bool network_ready, server_connects, auto_ack, stop_on_start, server_opened;
static bool server_keepalives;
static uint32_t server_ping_at;
static uint8_t failed_send_type;
static voice_packet_t server_in[8];
static unsigned server_used, server_read;
typedef struct { voice_header_t header; uint8_t payload[VOICE_PAYLOAD]; } sent_t;
static sent_t sent[128];
static unsigned sent_count;
/* Fake servo: what the real one reports is covered by servo_call_test. */
static servo_call_status_t servo_state;
static unsigned call_presses, end_presses, cancels, opens, closes;
static bool servo_open_ok, call_completes, end_completes, cancel_completes;
static bool servo_needs_recovery, servo_is_moving, servo_is_testing;
static bool shared_pusher, pusher_get_ok, pending_pusher;
static int servo_held;
static bool call_fails, end_fails, close_drops_ack, server_poll_fails, stop_in_sleep;
static char order[16];
static unsigned order_count;
static void note(char what) { if (order_count+1u<sizeof(order)) { order[order_count++]=what; order[order_count]=0; } }
/* Stop the real infinite task only at its outer poll boundary. */
static jmp_buf task_poll_boundary;
static bool stop_after_task_poll, chime_on_next_task_sleep;
static unsigned task_sleeps_to_skip;
/* Fake speaker: playback.c itself is covered by playback_test. */
static uint32_t fake_credit, pushed_frames;
static bool fake_done, fake_open_ok, fake_full, fake_idle, push_ok;
static const char *fake_error;
static unsigned playback_opens, playback_finishes, playback_aborts;

volatile audio_link_t *audio_link(void) { return &mailbox; }
void audio_link_acquire(void) { }
void audio_link_release(void) { }
uint32_t net_now_ms(void) { return tick; }
void net_sleep_ms(uint32_t ms)
{
    tick += ms;
    if (stop_in_sleep) stop_requested=true;
    if (auto_ack) mailbox.voice_call_ack = mailbox.voice_call_active;
    if (stop_after_task_poll && ms == 50u) {
        if (chime_on_next_task_sleep) { chime_on_next_task_sleep = false; ++mailbox.event_seq; }
        if (task_sleeps_to_skip) --task_sleeps_to_skip;
        else {
            stop_after_task_poll = false;
            longjmp(task_poll_boundary, 1);
        }
    }
}
void net_random(void *out, size_t length) { memset(out, 0x11, length); }
bool net_voice_ready(void) { return network_ready; }
uint32_t tune_voice_gate(void) { return 600u; }
static bool post_ok;
static char posted;
static uint32_t audio_refusal; /* what the audio task answers to the command */
bool audio_app_post_command(char c) { posted=c; mailbox.loopback_failed=audio_refusal; return post_ok; }
void audio_app_loopback_release(void) { mailbox.loopback_samples=0; }
bool servo_recovery_required(void) { return servo_needs_recovery; }
bool servo_motion_busy(void) { return servo_is_moving; }
bool servo_test_busy(void) { return servo_is_testing; }
bool servo_pusher_get(servo_pusher_config_t *out) {
    assert(servo_held==1);
    *out=(servo_pusher_config_t){.call_start=1,.call_end=shared_pusher?1:2};
    return pusher_get_ok;
}
bool servo_call_open(void) {
    ++opens;
    if (!servo_open_ok || servo_needs_recovery || servo_is_moving || servo_is_testing || pending_pusher) return false;
    servo_state=SERVO_CALL_PENDING; ++servo_held; return true;
}
bool servo_call_press(void) { ++call_presses; note('B'); if (call_fails) servo_state=SERVO_CALL_FAILED; else if (call_completes) servo_state=SERVO_CALL_STARTED; return true; }
bool servo_end_press(void) { ++end_presses; note('E'); if (end_fails) servo_state=SERVO_CALL_FAILED; else if (end_completes) servo_state=SERVO_CALL_ENDED; return true; }
void servo_call_cancel(void) { ++cancels; servo_state=cancel_completes?SERVO_CALL_ENDED:SERVO_CALL_FAILED; }
servo_call_status_t servo_call_status(void) { return servo_state; }
void servo_call_close(void) { ++closes; --servo_held; if (close_drops_ack) auto_ack=false; }
bool playback_open(uint32_t now) { (void)now; ++playback_opens; pushed_frames=0; return fake_open_ok; }
bool playback_push(const uint8_t *pcm, size_t bytes, uint32_t now)
{ (void)now; assert(pcm && bytes); if (push_ok) ++pushed_frames; return push_ok; }
void playback_finish(void) { ++playback_finishes; }
bool playback_full(void) { return fake_full; }
uint32_t playback_credit(void) { return fake_credit; }
bool playback_done(void) { return fake_done; }
static uint32_t fake_started;
uint32_t playback_started_ms(void) { return fake_started; }
const char *playback_error(void) { return fake_error; }
void playback_abort(void) { ++playback_aborts; }
bool playback_idle(void) { return fake_idle; }
void voice_transport_init(voice_transport_t *link) { memset(link, 0, sizeof(*link)); }
static bool api_configured = true;
bool voice_transport_configured(void) { return api_configured; }
bool voice_transport_server(voice_transport_t *link) {
    assert(link == &call.server && (link->diagnostic || (EXPECT_API_FIRST ? !call.may_have_answered : call.state == CONNECT_AGENT)));
    note('A');
    server_opened=true; link->websocket=true; return server_connects;
}
void voice_transport_close(voice_transport_t *link) { (void)link; }
bool voice_transport_legacy(const voice_transport_t *link) { return link->websocket && link->relay.legacy; }
bool voice_transport_send(voice_transport_t *link, const voice_header_t *header, const void *payload)
{
    assert(link == &call.server);
    assert(sent_count < sizeof(sent) / sizeof(sent[0]));
    assert(header->length <= VOICE_PAYLOAD);
    sent_t *out = &sent[sent_count++];
    out->header = *header;
    if (header->length) { assert(payload); memcpy(out->payload, payload, header->length); }
    if (stop_on_start && header->type == VOICE_CALL_START) stop_requested = true;
    return header->type != failed_send_type;
}
int voice_transport_poll(voice_transport_t *link, voice_packet_t *packet)
{
    assert(link == &call.server);
    if (server_poll_fails) return -1;
    if (server_read == server_used) {
        if (!server_keepalives || (uint32_t)(tick-server_ping_at)<1000u) return 0;
        server_ping_at=tick;
        memset(packet,0,sizeof(*packet));
        packet->header.type=VOICE_PING; packet->header.session=call.session;
        return 1;
    }
    *packet = server_in[server_read++];
    return 1;
}

static void reset(void)
{
    call_diag_pending=call_diag_greeting_seen=false;diag_stores=0;diag_store_ok=true;
    memset(&call_diag,0,sizeof(call_diag));memset(&stored_diag,0,sizeof(stored_diag));
    memset(&call, 0, sizeof(call));
    memset(&mailbox, 0, sizeof(mailbox));
    memset(sent, 0, sizeof(sent));
    tick = 1000u;
    fake_started = 0u;
    network_ready = server_connects = auto_ack = servo_open_ok = post_ok = true;
    call_completes = end_completes = cancel_completes = true;
    stop_on_start = busy = start_requested = stop_requested = recovery_required = recovery_confirm_requested = false;
    servo_needs_recovery = servo_is_moving = servo_is_testing = stop_after_task_poll = false;
    chime_on_next_task_sleep = false; task_sleeps_to_skip = 0u;
    probe_requested = 0u;
    cooldown_active=server_keepalives=false;
    cooldown_began=server_ping_at=0;
    server_opened=false;
    call_fails=end_fails=close_drops_ack=server_poll_fails=stop_in_sleep=false;
    shared_pusher=pending_pusher=false; pusher_get_ok=true; servo_held=0;
    order_count=0; order[0]=0;
    recovery_began=recovery_logged=recovery_delay_ms=recovery_attempts=0;
    recovery_log_seen=recovery_end_pending=false;
    failed_send_type = 0u;
    server_used = server_read = sent_count = 0u;
    servo_state = SERVO_CALL_PENDING;
    call_presses = end_presses = cancels = opens = closes = 0u;
    fake_credit = pushed_frames = 0u;
    fake_done = fake_full = false; fake_open_ok = fake_idle = push_ok = true;
    fake_error = NULL;
    playback_opens = playback_finishes = playback_aborts = 0u;
    call.session = 123u;
    call.turn = 1u;
    call.state = WAIT_REPLY;
    mailbox.audio_status = 1u;
    mailbox.voice_call_ack = mailbox.voice_call_active = 1u;
}
static voice_packet_t packet(uint8_t type, uint32_t turn, uint32_t sequence)
{
    voice_packet_t p = { .header = { .type = type, .session = 123u, .turn = turn, .sequence = sequence } };
    if (type == VOICE_OUTPUT_AUDIO) p.header.length = 640u;
    return p;
}
static bool from_server(uint8_t type, uint32_t turn, uint32_t sequence)
{ voice_packet_t p = packet(type, turn, sequence); return server_packet(&p); }
static unsigned count_sent(uint8_t type)
{
    unsigned count = 0;
    for (unsigned i = 0; i < sent_count; ++i) if (sent[i].header.type == type) ++count;
    return count;
}
static void output_to_end(bool final)
{
    assert(from_server(VOICE_OUTPUT_START, 1u, 0u));
    assert(from_server(VOICE_OUTPUT_AUDIO, 1u, 0u));
    assert(from_server(VOICE_OUTPUT_AUDIO, 1u, 1u));
    voice_packet_t p = packet(VOICE_OUTPUT_END, 1u, 2u);
    p.header.flags = final ? 1u : 0u;
    assert(server_packet(&p));
}
static void test_wait_for_actual_playback_done(void)
{
    reset();
    output_to_end(false);
    assert(call.state == PLAYING && mailbox.voice_record_enabled == 0u);
    assert(playback_opens == 1u && pushed_frames == 2u && playback_finishes == 1u);
    assert(!from_server(VOICE_LISTEN, 2u, 0u));
    assert(playback_progress() && call.state == PLAYING && count_sent(VOICE_AUDIO_ACK) == 0u);
    assert(!call.playback_start_marked); /* speaker not started yet */
    fake_started = 1234u;
    fake_credit = 2u;
    assert(playback_progress());
    assert(call.playback_start_marked); /* [TIMING] playback_start, once per response */
    assert(count_sent(VOICE_AUDIO_ACK) == 1u && call.output_ack == 2u);
    assert(playback_progress() && count_sent(VOICE_AUDIO_ACK) == 1u); /* only new credit */
    assert(call.state == PLAYING && mailbox.voice_record_enabled == 0u);
    assert(!from_server(VOICE_LISTEN, 2u, 0u)); /* ACK is not speaker drain. */
    fake_done = true;
    assert(playback_progress());
    assert(call.state == WAIT_LISTEN && mailbox.voice_record_enabled == 0u);
    assert(count_sent(VOICE_PLAYBACK_DONE) == 1u);
    assert(playback_progress() && count_sent(VOICE_PLAYBACK_DONE) == 1u);
    assert(from_server(VOICE_LISTEN, 2u, 0u));
    assert(call.state == LISTEN_DELAY && mailbox.voice_record_enabled == 0u);
    tick += VOICE_SETTLE_MS;
    assert(begin_listen());
    assert(call.state == LISTENING && mailbox.voice_record_enabled == 1u);
    assert(mailbox.voice_listen_seq == call.listen_generation && mailbox.voice_listen_turn == 2u);
    assert(mailbox.voice_rms_gate == 600u);
    assert(count_sent(VOICE_INPUT_START) == 1u);
}
static void test_stale_and_mismatched_packets(void)
{
    reset();
    voice_packet_t wrong = packet(VOICE_OUTPUT_START, 1u, 0u);
    wrong.header.session++;
    assert(!server_packet(&wrong));
    assert(!from_server(VOICE_OUTPUT_START, 2u, 0u));
    assert(!from_server(VOICE_OUTPUT_AUDIO, 1u, 0u)); /* before output_start */
    assert(from_server(VOICE_OUTPUT_START, 1u, 0u));
    assert(!from_server(VOICE_OUTPUT_START, 1u, 0u));
    assert(!from_server(VOICE_OUTPUT_AUDIO, 1u, 3u)); /* out of order */
    assert(!from_server(VOICE_OUTPUT_END, 1u, 0u));  /* nothing played */
    assert(from_server(VOICE_OUTPUT_AUDIO, 1u, 0u));
    assert(!from_server(VOICE_OUTPUT_END, 1u, 5u));  /* wrong total */
    assert(from_server(VOICE_OUTPUT_END, 1u, 1u));
    assert(!from_server(VOICE_OUTPUT_AUDIO, 1u, 1u)); /* after the end */
    /* Completion cannot be reported while credit is still short. */
    fake_done = true; fake_credit = 0u;
    assert(!playback_progress());
    assert(count_sent(VOICE_PLAYBACK_DONE) == 0u);
    reset();
    wrong = packet(VOICE_LISTEN, 2u, 0u); wrong.header.session++;
    assert(!server_packet(&wrong));
    /* Audio that the speaker cannot take fails with a reason, not silently. */
    assert(from_server(VOICE_OUTPUT_START, 1u, 0u));
    push_ok = false;
    assert(!from_server(VOICE_OUTPUT_AUDIO, 1u, 0u));
    assert(!strcmp(call.io_failure, "audio_queue_full"));
    reset(); fake_open_ok = false;
    assert(!from_server(VOICE_OUTPUT_START, 1u, 0u));
    assert(!strcmp(call.io_failure, "speaker_busy"));
    reset();
    assert(from_server(VOICE_OUTPUT_START, 1u, 0u));
    fake_error = "speaker_progress_timeout";
    assert(!playback_progress() && !strcmp(call.io_failure, "speaker_progress_timeout"));
}
static void test_no_reply_and_final_end(void)
{
    reset();
    assert(from_server(VOICE_NO_REPLY, 1u, 0u));
    assert(call.state == WAIT_LISTEN);
    assert(from_server(VOICE_LISTEN, 2u, 0u));
    assert(begin_listen() && mailbox.voice_record_enabled == 1u);
    reset();
    output_to_end(true);
    fake_credit = 2u; fake_done = true;
    assert(playback_progress());
    assert(!from_server(VOICE_LISTEN, 2u, 0u)); /* Final speech must never resume capture. */
    end_completes = false;
    assert(end_presses == 0u);
    assert(from_server(VOICE_CALL_END, 1u, 0u));
    assert(call.state == ENDING && end_presses == 1u && mailbox.voice_record_enabled == 0u);
    assert(!from_server(VOICE_LISTEN, 2u, 0u));
}
static void prepare_capture(void)
{
    reset();
    call.state = LISTENING;
    call.listen_generation = 7u;
    call.phase = tick;
    mailbox.voice_record_enabled = 1u;
    mailbox.voice_listen_ack = mailbox.voice_listen_seq = 7u;
}
static void test_capture_end_boundary_and_failures(void)
{
    prepare_capture();
    mailbox.voice_write_seq = mailbox.voice_end_seq = 3u;
    mailbox.voice_end_listen_seq = 7u;
    mailbox.voice_end_reason = 1u;
    mailbox.voice_end_turn = 1u;
    mailbox.voice_samples = 960u;
    mailbox.voice_pcm[0][0] = -1234;
    assert(capture_step());
    assert(mailbox.voice_read_seq == 3u && call.input_count == 3u);
    assert(call.state == WAIT_REPLY && mailbox.voice_record_enabled == 0u);
    assert(count_sent(VOICE_INPUT_AUDIO) == 3u && count_sent(VOICE_INPUT_END) == 1u);
    assert(sent[0].payload[0] == (uint8_t)(uint16_t)-1234);
    assert(sent[0].payload[1] == (uint8_t)((uint16_t)-1234 >> 8));
    prepare_capture();
    tick += 50000u; /* Initial quiet time must not shorten the next 30 s turn. */
    mailbox.voice_write_seq = 1u;
    assert(capture_step() && call.phase == tick && call.input_count == 1u);
    uint32_t speech_start = call.phase;
    tick += 100u;
    mailbox.voice_write_seq = 2u;
    assert(capture_step() && call.phase == speech_start && call.input_count == 2u);
    for (unsigned reason = 3u; reason <= 5u; ++reason) {
        prepare_capture();
        mailbox.voice_end_listen_seq = 7u;
        mailbox.voice_end_reason = reason;
        assert(!capture_step() && count_sent(VOICE_INPUT_END) == 0u);
    }
    prepare_capture();
    mailbox.voice_write_seq = AUDIO_LINK_RING_FRAMES + 1u;
    assert(!capture_step() && count_sent(VOICE_INPUT_END) == 0u);
    prepare_capture();
    mailbox.voice_write_seq = 1u;
    failed_send_type = VOICE_INPUT_AUDIO;
    assert(!capture_step() && mailbox.voice_read_seq == 0u);
    assert(count_sent(VOICE_INPUT_END) == 0u);
    prepare_capture();
    mailbox.voice_listen_ack = 6u;
    assert(capture_step() && sent_count == 0u);
    tick += 2000u;
    assert(!capture_step());
}
static void fresh_call(void)
{
    reset();
    mailbox.voice_call_active = mailbox.voice_call_ack = 0u;
}
static void poll_task_once(void)
{
    stop_after_task_poll = true;
    if (!setjmp(task_poll_boundary)) voice_stream_task(NULL);
    assert(!stop_after_task_poll);
}
static void test_stop_and_uncertain_shutdown(void)
{
    /* Stop before anything moved. */
    fresh_call();
    voice_stream_request_stop();
    assert(stop_requested && !await_ready());
    assert(run_call(123u));
    assert(call_presses == 0u && cancels == 0u);
    assert(mailbox.voice_record_enabled == 0u && mailbox.voice_call_ack == 0u);
    /* Stop during the call, with a cancel that cannot be confirmed. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY, 0u, 0u);
    stop_on_start = true;
    cancel_completes = false;
    busy = true;
    assert(!run_call(123u));
    assert(!voice_stream_busy() && recovery_required);
    voice_stream_request_call(); assert(!start_requested);
    assert(count_sent(VOICE_CALL_START) == 1u && cancels == 1u);
    assert(count_sent(VOICE_CANCEL) == 1u);
    assert(playback_aborts == 1u);
    assert(mailbox.voice_record_enabled == 0u && mailbox.voice_call_active == 1u);
    assert(mailbox.voice_call_ack == 1u); /* Unknown state keeps microphone/chime muted. */
    /* Stop during the call, with a confirmed end. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY, 0u, 0u);
    stop_on_start = true;
    assert(run_call(123u));
    assert(cancels == 1u && closes == 1u);
    assert(mailbox.voice_call_ack == 0u && mailbox.voice_record_enabled == 0u);
    /* No usable API settings: the intercom is left alone, not answered and hung up on. */
    fresh_call();
    api_configured = false;
    assert(run_call(123u));
    api_configured = true;
    assert(opens == 0u && call_presses == 0u && end_presses == 0u && !server_opened && !recovery_required);
    assert(mailbox.voice_call_ack == 0u);
    /* Servos held by calibration or a test: no call, no agent, no recovery lock. */
    fresh_call();
    servo_open_ok = false;
    assert(run_call(123u));
    assert(!server_opened && call_presses == 0u && closes == 0u && !recovery_required);
    assert(mailbox.voice_call_ack == 0u);
}
static void test_legacy_early_vad_and_stale_input(void)
{
    prepare_capture();
    call.server.websocket=call.server.relay.legacy=true;
    mailbox.voice_write_seq=3; mailbox.voice_read_seq=0;
    // The deployed backend's VAD can reply while the endpoint is still
    // capturing its longer 1.2 second silence boundary.
    output_to_end(false);
    assert(call.state==PLAYING && mailbox.voice_record_enabled==0);
    fake_credit=2; fake_done=true;
    assert(playback_progress());
    assert(from_server(VOICE_LISTEN,2,0));
    assert(begin_listen());
    assert(mailbox.voice_read_seq==3 && mailbox.voice_record_enabled==1);
    assert(call.state==LISTENING && call.turn==2);
}
static void test_agent_only_after_button_released(void)
{
    /* Connection failure after the press still ends the intercom call. */
#if !EXPECT_API_FIRST
    fresh_call();
    server_connects=false;
    assert(run_call(123));
    assert(server_opened && call_presses==1 && cancels==1 && closes==1);
    assert(mailbox.voice_call_ack==0);
#endif
    /* A failed button action never starts an agent. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    call_completes=false; call_fails=true;
    assert(run_call(123));
    assert(call_presses==1 && cancels==1);
    assert(server_opened == EXPECT_API_FIRST); /* v2: only the idle session, never an agent */
    assert(count_sent(VOICE_CALL_START)==0);
    /* Network loss while waiting for the button: no agent either. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    call_completes=false; network_ready=false;
    assert(run_call(123) && count_sent(VOICE_CALL_START)==0);
    assert(server_opened == EXPECT_API_FIRST);
}
static void test_whole_call(void)
{
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    server_in[server_used++] = packet(VOICE_CALL_END,0,0);
    assert(run_call(123));
    assert(call_presses==1 && end_presses==1 && cancels==0 && closes==1);
    assert(count_sent(VOICE_HELLO)==1 && count_sent(VOICE_CALL_START)==1 && count_sent(VOICE_CALL_ENDED)==1);
    assert(mailbox.voice_call_ack==0 && !recovery_required);
    /* Server errors and silence cannot leave the call running. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    server_in[server_used++] = packet(VOICE_ERROR,0,0);
    assert(run_call(123) && cancels==1);
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    assert(run_call(123) && cancels==1); /* server keepalive/response timeout */
    /* A full speaker queue leaves data unread instead of failing. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    server_in[server_used++] = packet(VOICE_OUTPUT_START,0,0);
    fake_full=true;
    assert(run_call(123));
    assert(server_read==1); /* OUTPUT_START stayed queued; READY was consumed before */
}
/* v2 proves the API usable before the servo answers the intercom; v1 keeps the old order. */
static void test_api_is_proven_before_the_button(void)
{
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    server_in[server_used++] = packet(VOICE_CALL_END,0,0);
    assert(run_call(123));
#if EXPECT_API_FIRST
    assert(!strcmp(order, "ABE")); /* API open (and READY consumed) -> call button -> END */
#else
    assert(!strcmp(order, "BAE"));
#endif
    assert(count_sent(VOICE_HELLO)==1 && sent[0].header.type==VOICE_HELLO);
    assert(count_sent(VOICE_CALL_START)==1 && !recovery_required);
#if EXPECT_API_FIRST
    /* API down: the intercom is never touched and chime detection is re-armed. */
    fresh_call();
    server_connects = false;
    assert(run_call(123));
    assert(!strcmp(order, "A") && call_presses==0 && end_presses==0 && cancels==0 && count_sent(VOICE_CALL_START)==0);
    assert(!recovery_required && mailbox.voice_call_ack==0 && closes==1);
    /* TLS/WSS up but no READY (wrong key, dead relay): still no press. */
    fresh_call();
    assert(run_call(123));
    assert(!strcmp(order, "A") && call_presses==0 && end_presses==0 && !recovery_required);
    assert(tick-1000u>=60000u && count_sent(VOICE_CALL_START)==0);
    /* READY refused by an ERROR packet. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_ERROR,0,0);
    assert(run_call(123));
    assert(!strcmp(order, "A") && call_presses==0 && !recovery_required);
    /* Stop requested during the API connection. */
    fresh_call();
    voice_stream_request_stop();
    assert(run_call(123));
    assert(call_presses==0 && !server_opened);
    /* Servos busy: the API is not even opened. */
    fresh_call();
    servo_open_ok = false;
    assert(run_call(123));
    assert(!server_opened && call_presses==0 && !recovery_required);
    /* While the button is pressed, the idle API session is kept alive. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    call_completes = false; network_ready = true;
    assert(run_call(123));
    assert(count_sent(VOICE_PING) >= 9u && count_sent(VOICE_CALL_START)==0 && cancels==1);
    /* ...and its loss while the button is held is noticed (the caller then ends the call). */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    call_completes = false;
    memset(&call,0,sizeof(call)); call.session=123u;
    {
        const char *reason="";
        assert(connect_server(&reason));
        server_poll_fails = true;
        assert(!await_call_started() && !strcmp(call.io_failure, "server_connection_lost"));
        server_poll_fails = false;
    }
    /* A packet that is not valid before call_started is a protocol error, not ignored. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY,0,0);
    server_in[server_used++] = packet(VOICE_OUTPUT_START,1,0);
    call_completes = false;
    assert(run_call(123));
    assert(call_presses==1 && cancels==1 && count_sent(VOICE_CALL_START)==0);
#endif
}
/* Make a call whose end cannot be confirmed: the board must recover on its own. */
static void uncertain_call(void)
{
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY, 0u, 0u);
    stop_on_start = true;
    cancel_completes = false;
    busy = true;
    assert(!run_call(123u));
    assert(recovery_required && recovery_end_pending && !busy);
    assert(recovery_delay_ms == VOICE_RECOVERY_RETRY_MIN_MS && recovery_began == tick);
    assert(call_presses == 1u && end_presses == 0u);
    stop_requested = false; stop_on_start = false; cancel_completes = true;
}
static void test_automatic_recovery(void)
{
    uncertain_call();
    unsigned presses = call_presses, opens_before = opens, sent_before = sent_count;
    bool opened_before = server_opened;
    /* Nothing before the first delay; the recovery flag also keeps new calls out. */
    tick += VOICE_RECOVERY_RETRY_MIN_MS - 1u;
    recovery_step();
    assert(recovery_required && opens == opens_before && recovery_attempts == 0u);
    voice_stream_request_call(); assert(!start_requested);
    /* 10 s: servo still busy -> retry in 20 s, then 30 s, capped at 30 s. */
    servo_open_ok = false;
    tick += 1u; recovery_step();
    assert(recovery_required && recovery_attempts == 1u && recovery_delay_ms == 20000u && !busy);
    uint32_t first_log = recovery_logged;
    assert(recovery_log_seen);
    tick += 19999u; recovery_step(); assert(recovery_attempts == 1u);
    tick += 1u; recovery_step();
    assert(recovery_attempts == 2u && recovery_delay_ms == 30000u);
    assert(recovery_logged == first_log); /* failed attempts are logged at most once a minute */
    tick += 30000u; recovery_step();
    assert(recovery_attempts == 3u && recovery_delay_ms == 30000u && recovery_logged == first_log); /* 50 s since the log */
    assert(end_presses == 0u); /* servo refused: nothing pressed */
    /* END is pressed but never completes: still uncertain, and the next try comes later. */
    servo_open_ok = true; end_completes = false;
    tick += 30000u;
    uint32_t attempt_began = tick;
    recovery_step();
    assert(recovery_required && recovery_end_pending && end_presses == 1u && recovery_attempts == 4u);
    assert(recovery_logged > first_log); /* 80 s since the first log: logged again */
    assert(tick - attempt_began >= VOICE_RECOVERY_CONFIRM_MS && tick - attempt_began < VOICE_RECOVERY_CONFIRM_MS + 100u);
    /* END reports failure. */
    end_completes = true; end_fails = true;
    tick += 30000u; recovery_step();
    assert(recovery_required && recovery_end_pending && end_presses == 2u);
    /* A stop request while waiting ends the attempt but keeps the lock. */
    end_fails = false; end_completes = false; stop_in_sleep = true;
    tick += 30000u;
    recovery_step();
    assert(recovery_required && end_presses == 3u && stop_requested);
    stop_in_sleep = false;
    /* Finally the servo ends the call: capture is re-armed, calls are allowed again. */
    end_completes = true;
    tick += 30000u; recovery_step();
    assert(!recovery_required && !recovery_end_pending && end_presses == 4u);
    assert(mailbox.voice_call_active == 0u && mailbox.voice_call_ack == 0u);
    assert(call_presses == presses);              /* never the call button */
    assert(server_opened == opened_before);       /* never the API */
    assert(sent_count == sent_before);            /* never a packet to the server */
    assert(opens > opens_before && servo_held == 0); /* every ownership was released */
    voice_stream_request_call(); assert(start_requested);
    /* Idle again: nothing more happens. */
    tick += 60000u; recovery_step();
    assert(end_presses == 4u && recovery_attempts == 7u);
}
static void test_recovery_edge_cases(void)
{
    /* Not owed an END (only the microphone could not be re-armed): no servo is touched. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY, 0u, 0u);
    server_in[server_used++] = packet(VOICE_CALL_END, 0u, 0u);
    close_drops_ack = true;
    assert(!run_call(123u));
    assert(recovery_required && !recovery_end_pending && end_presses == 1u);
    unsigned opens_before = opens, end_before = end_presses;
    auto_ack = true;
    tick += VOICE_RECOVERY_RETRY_MIN_MS; recovery_step();
    assert(!recovery_required && opens == opens_before && end_presses == end_before);
    assert(call_presses == 1u && mailbox.voice_call_ack == 0u);
    /* The microphone link stays dead: keep retrying, keep the lock. */
    fresh_call();
    server_in[server_used++] = packet(VOICE_READY, 0u, 0u);
    server_in[server_used++] = packet(VOICE_CALL_END, 0u, 0u);
    close_drops_ack = true;
    assert(!run_call(123u));
    close_drops_ack = false;
    tick += VOICE_RECOVERY_RETRY_MIN_MS; recovery_step();
    assert(recovery_required && recovery_attempts == 1u);
    auto_ack = true;
    tick += 20000u; recovery_step();
    assert(!recovery_required);
    /* busy blocks recovery (a call or diagnostic owns the board). */
    uncertain_call();
    busy = true;
    tick += 60000u; unsigned attempts = recovery_attempts;
    recovery_step();
    assert(recovery_required && recovery_attempts == attempts && end_presses == 0u);
    busy = false;
    /* Nothing to recover from: no effect. */
    reset();
    unsigned opens_idle = opens;
    recovery_step();
    assert(!recovery_required && opens == opens_idle);
}
static void test_api_probe_does_not_start_conversation(void)
{
    reset();
    server_in[server_used++]=packet(VOICE_READY,0,0);
    server_in[server_used++]=packet(VOICE_PONG,0,1);
    assert(run_api_probe(123));
    assert(sent_count==3 && count_sent(VOICE_CALL_START)==0 && count_sent(VOICE_INPUT_AUDIO)==0);
    assert(count_sent(VOICE_HELLO)==1 && count_sent(VOICE_PING)==1 && count_sent(VOICE_CANCEL)==1);
    assert(mailbox.voice_record_enabled==0 && call_presses==0 && end_presses==0);
    reset(); server_connects=false;
    assert(!run_api_probe(123) && sent_count==0);
}
static void test_local_sound_checks(void)
{
    /* Speaker test: fifty 20 ms frames, then real completion; microphone back afterwards. */
    fresh_call(); fake_done=true;
    run_speaker_test();
    assert(pushed_frames==50u && playback_finishes==1u && mailbox.voice_call_active==0u);
    /* A speaker failure is reported and aborts playback. */
    fresh_call(); fake_error="speaker_start_failed"; push_ok=false;
    run_speaker_test();
    assert(playback_aborts==1u && mailbox.voice_call_active==0u);
    /* A push that never succeeds gives up instead of hanging the call task. */
    fresh_call(); push_ok=false;
    int16_t pcm[700]={0};
    assert(!play_samples(pcm,700));
    assert(playback_aborts==1u && tick-1000u>=30000u);
    /* Loopback: plays what the audio task recorded, in 20 ms frames, then releases it. */
    static int16_t recorded[700];
    audio_jobs.pending_pcm=recorded;
    fresh_call(); fake_done=true; mailbox.loopback_samples=700u;
    run_loopback();
    assert(posted=='l' && pushed_frames==3u && mailbox.loopback_samples==0u);
    assert(mailbox.voice_call_active==0u);
    /* Refused by the audio task, or the audio task is gone. */
    for (uint32_t refusal=1u;refusal<=2u;++refusal) {
        fresh_call(); audio_refusal=refusal;
        run_loopback(); assert(playback_opens==0u && tick-1000u<5000u);
    }
    audio_refusal=0u;
    fresh_call(); mailbox.loopback_failed=0u; post_ok=false;
    run_loopback(); assert(playback_opens==0u);
    fresh_call();
    run_loopback(); assert(playback_opens==0u && tick-1000u>=5000u);
}
static void test_call_time_limit(void)
{
    /* Exact 50 s boundary, including millis() wrapping through zero. */
    const uint32_t starts[]={0u,1000u,UINT32_MAX-100u};
    for (unsigned i=0;i<sizeof(starts)/sizeof(starts[0]);++i) {
        reset(); call.began=starts[i]; call.may_have_answered=true;
        tick=call.began+49999u; assert(!call_time_limit_reached());
        tick+=1u; assert(call_time_limit_reached());
        call.may_have_answered=false; assert(!call_time_limit_reached());
    }
    /* The real session loop must stop even if a responsive server never sends
     * a greeting. Keepalives prevent the shorter connection watchdog firing. */
    fresh_call();
    server_in[server_used++]=packet(VOICE_READY,0,0); server_keepalives=true;
    assert(run_call(123u));
    assert(call_presses==1u && cancels==1u && closes==1u);
    assert(cooldown_began-call.began==50000u);
    assert(count_sent(VOICE_CALL_START)==1u && count_sent(VOICE_CANCEL)==1u);
    assert(call_diag_pending && pending_call_diag.reason==19u && pending_call_diag.greeting_ms==0u);
    assert(pending_call_diag.started_ms==call.began && pending_call_diag.ended_ms-call.began==50000u);
    assert(!pending_call_diag.input_frames && !pending_call_diag.input_end_sent);
    fresh_call(); server_keepalives=true;
    assert(run_call(123u));
#if EXPECT_API_FIRST
    assert(call_presses==0u && cancels==0u && !cooldown_active);
#else
    assert(cooldown_began-call.began==50000u);
    assert(call_presses==1u && cancels==1u);
#endif
    assert(count_sent(VOICE_CALL_START)==0u);
    /* A diagnostic does not own an intercom call or inherit its deadline. */
    reset(); call.server.diagnostic=true; tick=UINT32_MAX;
    server_in[server_used++]=packet(VOICE_READY,0,0);
    assert(await_ready());
}
static void test_post_call_cooldown(void)
{
    const uint32_t starts[]={0u,1000u,UINT32_MAX-100u};
    for (unsigned i=0;i<sizeof(starts)/sizeof(starts[0]);++i) {
        reset(); tick=starts[i]; start_requested=true;
        begin_call_cooldown(); assert(!start_requested);
        tick+=19999u;
        bool detected=true; voice_stream_request_call();
        assert(!start_requested); /* Rejected even before the scheduler polls. */
        suppress_cooldown_requests(&detected);
        assert(!detected && !start_requested && cooldown_active);
        /* Requests made during cooldown never reappear at expiry. */
        tick+=1u; detected=true; suppress_cooldown_requests(&detected);
        assert(!detected && !start_requested && !cooldown_active);
        detected=true; voice_stream_request_call();
        suppress_cooldown_requests(&detected);
        assert(detected && start_requested);
    }
    /* No button attempt means no cooldown: setup can be fixed immediately. */
    fresh_call(); api_configured=false;
    assert(run_call(123u)); api_configured=true;
    assert(!cooldown_active && call_presses==0u);
    fresh_call(); voice_stream_request_stop();
    assert(run_call(123u) && !cooldown_active);
    /* API failure without a CALL has no cooldown; legacy v1 already pressed. */
    fresh_call(); server_connects=false;
    assert(run_call(123u) && cooldown_active==!EXPECT_API_FIRST && !recovery_required);
    /* Unconfirmed END must retain recovery independently of timer expiry. */
    fresh_call(); server_in[server_used++]=packet(VOICE_READY,0,0);
    stop_on_start=true; cancel_completes=false;
    assert(!run_call(123u) && cooldown_active && recovery_required);
    tick=cooldown_began+20000u;
    bool detected=false; suppress_cooldown_requests(&detected);
    assert(!cooldown_active && recovery_required);
    voice_stream_request_call(); assert(!start_requested);
}
static void test_servo_recovery_and_confirmation(void)
{
    /* A persisted servo interlock is stronger than the expired 20 s timer,
     * even if this voice task has no separate uncertain-shutdown state. */
    reset(); servo_needs_recovery = true;
    begin_call_cooldown(); tick += 20000u;
    voice_stream_request_call(); assert(!start_requested);
    bool detected = true; suppress_cooldown_requests(&detected);
    assert(!cooldown_active && !recovery_required && voice_stream_recovery_required());
    voice_stream_request_call(); assert(!start_requested);
    voice_stream_confirm_recovery(); assert(!recovery_confirm_requested);
    /* The operator cannot post a confirmation during an active voice call. */
    servo_needs_recovery = false; recovery_required = busy = true;
    voice_stream_confirm_recovery(); assert(!recovery_confirm_requested);
    voice_stream_request_call(); assert(!start_requested);

    reset(); recovery_required = recovery_end_pending = shared_pusher = true;
    servo_is_moving = true; voice_stream_confirm_recovery(); assert(!recovery_confirm_requested);
    servo_is_moving = false; servo_is_testing = true;
    voice_stream_confirm_recovery(); assert(!recovery_confirm_requested);
    servo_is_testing = false;
    assert(mailbox.voice_call_active == 1u && mailbox.voice_call_ack == 1u);
    voice_stream_confirm_recovery(); assert(recovery_confirm_requested);
    /* Conditions are checked again at consumption, not just when queued. */
    servo_needs_recovery = true; poll_task_once();
    assert(recovery_confirm_requested && voice_stream_recovery_required());
    assert(mailbox.voice_call_active == 1u && mailbox.voice_call_ack == 1u);
    servo_needs_recovery = false; servo_is_moving = true; poll_task_once();
    assert(recovery_confirm_requested && recovery_required);
    servo_is_moving = false; servo_is_testing = true; poll_task_once();
    assert(recovery_confirm_requested && recovery_required);
    servo_is_testing = false; busy = true; poll_task_once();
    assert(recovery_confirm_requested && recovery_required);
    assert(mailbox.voice_call_active == 1u && mailbox.voice_call_ack == 1u);
    /* Clearing the voice lock also requires the audio task's resume ACK. */
    busy = false; auto_ack = false; poll_task_once();
    assert(!recovery_confirm_requested && recovery_required && mailbox.voice_call_ack == 1u);
    voice_stream_request_call(); assert(!start_requested);
    auto_ack = true; voice_stream_confirm_recovery();
    start_requested = true; /* A stale request must not replay when unmuted. */
    poll_task_once();
    assert(!recovery_confirm_requested && !voice_stream_recovery_required() && !start_requested);
    assert(mailbox.voice_call_active == 0u && mailbox.voice_call_ack == 0u);
    assert(opens == closes && call_presses == 0u && end_presses == 0u);
    voice_stream_request_call(); assert(start_requested);
}
static void test_recovery_respects_current_mapping_and_locks(void)
{
    /* A shared toggle is never pressed a second time by automatic recovery. */
    uncertain_call(); shared_pusher=true;
    tick+=10000u; recovery_step();
    assert(recovery_required && end_presses==0u && servo_held==0);
    /* A servo-level manual lock blocks acquisition and cannot be dismissed. */
    servo_needs_recovery=true;
    unsigned opens_before=opens;
    tick+=20000u; recovery_step();
    assert(recovery_required && end_presses==0u && opens==opens_before);
    servo_needs_recovery=false; shared_pusher=false;
    /* Cloud pending settings and missing mapping readback also block motion. */
    pending_pusher=true;
    tick+=30000u; recovery_step();
    assert(recovery_required && pending_pusher && end_presses==0u);
    pending_pusher=false; pusher_get_ok=false;
    tick+=30000u; recovery_step();
    assert(recovery_required && end_presses==0u && servo_held==0);
    pusher_get_ok=true;
    tick+=30000u; recovery_step();
    assert(!recovery_required && end_presses==1u && call_presses==1u);
}
static void test_stop_mode_answers_nothing(void)
{
    /* The real task: a chime (second poll sees the new event) or a manual request. */
    for (unsigned manual = 0; manual < 2; ++manual) {
        fresh_call(); network_ready = true;
        assert(device_mode_apply(DEVICE_MODE_NORMAL));
        if (manual) { voice_stream_request_call(); assert(start_requested); }
        else { chime_on_next_task_sleep = true; task_sleeps_to_skip = 1u; }
        poll_task_once();
        assert(server_opened); /* an accepted mode starts the call, as before */
        /* Stop mode: nothing is opened, pressed, queued, or put in cooldown. */
        fresh_call(); network_ready = true;
        assert(device_mode_apply(DEVICE_MODE_OFF));
        if (manual) { voice_stream_request_call(); assert(start_requested); }
        else { chime_on_next_task_sleep = true; task_sleeps_to_skip = 1u; }
        poll_task_once();
        assert(!server_opened && !busy && !start_requested && !cooldown_active);
        assert(call_presses == 0u && end_presses == 0u && opens == 0u && mailbox.voice_call_active == 0u);
        /* Back to an accepted mode: the dropped request does not replay. */
        assert(device_mode_apply(DEVICE_MODE_AWAY));
        poll_task_once();
        assert(!server_opened && call_presses == 0u);
    }
    /* Diagnostics are not calls: the API probe still works in stop mode. */
    fresh_call(); network_ready = true; assert(device_mode_apply(DEVICE_MODE_OFF));
    server_in[server_used++]=packet(VOICE_READY,0,0); server_in[server_used++]=packet(VOICE_PONG,0,1);
    probe_requested = PROBE_API; poll_task_once();
    assert(server_opened && count_sent(VOICE_CALL_START) == 0);
    assert(device_mode_apply(DEVICE_MODE_OMAKASE));
}
static void test_call_diag_timing_and_single_save(void)
{
    reset();assert(from_server(VOICE_OUTPUT_START,1u,0u));
    tick=1100u;assert(from_server(VOICE_OUTPUT_AUDIO,1u,0u));assert(call_diag.greeting_ms==1100u);
    tick=1200u;assert(from_server(VOICE_OUTPUT_AUDIO,1u,1u));assert(call_diag.greeting_ms==1100u);
    for(unsigned legacy=0;legacy<2;++legacy) {
        reset();call.server.websocket=true;call.server.relay.legacy=legacy!=0;
        call.state=LISTENING;call.listen_generation=1u;
        mailbox.voice_listen_ack=mailbox.voice_end_listen_seq=1u;
        mailbox.voice_end_reason=1u;mailbox.voice_end_turn=call.turn;
        mailbox.voice_write_seq=mailbox.voice_end_seq=1u;mailbox.voice_samples=320u;
        assert(capture_step());assert(call_diag.input_frames==1u && call_diag.input_end_ms==tick);
        assert(call_diag.input_end_sent==(legacy?0u:1u));
    }
    reset();pending_call_diag=(voice_call_diag_t){.reason=19u,.turn=3u,.input_frames=12u};call_diag_pending=true;
    busy=true;flush_call_diag();assert(!diag_stores);
    busy=false;mailbox.voice_record_enabled=1u;flush_call_diag();assert(!diag_stores);
    mailbox.voice_record_enabled=0u;fake_idle=false;flush_call_diag();assert(!diag_stores);
    fake_idle=true;flush_call_diag();assert(diag_stores==1u && !call_diag_pending && stored_diag.input_frames==12u);
    flush_call_diag();assert(diag_stores==1u);
    call_diag_pending=true;diag_store_ok=false;flush_call_diag();flush_call_diag();
    assert(diag_stores==2u && !call_diag_pending); /* Failed save never retries per loop. */
}
int main(void)
{
    test_call_diag_timing_and_single_save();
    test_api_is_proven_before_the_button();
    test_automatic_recovery();
    test_recovery_edge_cases();
    test_recovery_respects_current_mapping_and_locks();
    test_call_time_limit();
    test_post_call_cooldown();
    test_servo_recovery_and_confirmation();
    test_api_probe_does_not_start_conversation();
    test_wait_for_actual_playback_done();
    test_stale_and_mismatched_packets();
    test_no_reply_and_final_end();
    test_capture_end_boundary_and_failures();
    test_stop_and_uncertain_shutdown();
    test_legacy_early_vad_and_stale_input();
    test_agent_only_after_button_released();
    test_whole_call();
    test_local_sound_checks();
    test_stop_mode_answers_nothing();
    puts("PASS: API/button order, separate-END recovery, shared locks, 50s deadline, 20s cooldown and safe stop");
    return 0;
}
