#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "voice_stream.c"

static audio_link_t mailbox;
audio_jobs_t audio_jobs;
static uint32_t tick;
static bool network_ready, server_connects, auto_ack, stop_on_start, server_opened;
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
    if (auto_ack) mailbox.voice_call_ack = mailbox.voice_call_active;
}
void net_random(void *out, size_t length) { memset(out, 0x11, length); }
bool net_voice_ready(void) { return network_ready; }
uint32_t tune_voice_gate(void) { return 600u; }
static bool post_ok;
static char posted;
bool audio_app_post_command(char c) { posted=c; return post_ok; }
void audio_app_loopback_release(void) { mailbox.loopback_samples=0; }
bool servo_call_open(void) { ++opens; return servo_open_ok; }
bool servo_call_press(void) { ++call_presses; if (call_completes) servo_state=SERVO_CALL_STARTED; return true; }
bool servo_end_press(void) { ++end_presses; if (end_completes) servo_state=SERVO_CALL_ENDED; return true; }
void servo_call_cancel(void) { ++cancels; servo_state=cancel_completes?SERVO_CALL_ENDED:SERVO_CALL_FAILED; }
servo_call_status_t servo_call_status(void) { return servo_state; }
void servo_call_close(void) { ++closes; }
bool playback_open(uint32_t now) { (void)now; ++playback_opens; pushed_frames=0; return fake_open_ok; }
bool playback_push(const uint8_t *pcm, size_t bytes, uint32_t now)
{ (void)now; assert(pcm && bytes); if (push_ok) ++pushed_frames; return push_ok; }
void playback_finish(void) { ++playback_finishes; }
bool playback_full(void) { return fake_full; }
uint32_t playback_credit(void) { return fake_credit; }
bool playback_done(void) { return fake_done; }
const char *playback_error(void) { return fake_error; }
void playback_abort(void) { ++playback_aborts; }
bool playback_idle(void) { return fake_idle; }
void voice_transport_init(voice_transport_t *link) { memset(link, 0, sizeof(*link)); }
bool voice_transport_server(voice_transport_t *link) {
    assert(link == &call.server && (call.state == CONNECT_AGENT || link->diagnostic));
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
    if (server_read == server_used) return 0;
    *packet = server_in[server_read++];
    return 1;
}

static void reset(void)
{
    memset(&call, 0, sizeof(call));
    memset(&mailbox, 0, sizeof(mailbox));
    memset(sent, 0, sizeof(sent));
    tick = 1000u;
    network_ready = server_connects = auto_ack = servo_open_ok = post_ok = true;
    call_completes = end_completes = cancel_completes = true;
    stop_on_start = busy = start_requested = stop_requested = recovery_required = false;
    server_opened=false;
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
    fake_credit = 2u;
    assert(playback_progress());
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
    fresh_call();
    server_connects=false;
    assert(run_call(123));
    assert(server_opened && call_presses==1 && cancels==1 && closes==1);
    assert(mailbox.voice_call_ack==0);
    /* A failed button action never starts an agent. */
    fresh_call();
    call_completes=false; servo_state=SERVO_CALL_FAILED;
    assert(run_call(123));
    assert(!server_opened && call_presses==1 && cancels==1);
    /* Network loss while waiting for the button: no agent either. */
    fresh_call();
    call_completes=false; network_ready=false;
    assert(run_call(123) && !server_opened);
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
    fresh_call(); mailbox.loopback_failed=0u; post_ok=false;
    run_loopback(); assert(playback_opens==0u);
    fresh_call();
    run_loopback(); assert(playback_opens==0u && tick-1000u>=5000u);
}
int main(void)
{
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
    puts("PASS: playback gating, packet identity, final turn, capture errors, safe stop and local sound checks");
    return 0;
}
