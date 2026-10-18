#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "voice_stream.c"

static e84_shared_t mailbox;
static TickType_t tick;
static bool network_ready, server_connects, m5_connects, auto_ack, stop_on_start;
static uint8_t failed_send_type;
static voice_packet_t server_in[8], m5_in[8];
static unsigned server_used, server_read, m5_used, m5_read;
typedef struct { bool to_server; voice_header_t header; uint8_t payload[VOICE_PAYLOAD]; } sent_t;
static sent_t sent[128];
static unsigned sent_count;

volatile e84_shared_t *e84_shared(void) { return &mailbox; }
void e84_shared_acquire(void) { }
void e84_shared_release(void) { }
TickType_t xTaskGetTickCount(void) { return tick; }
void vTaskDelay(TickType_t ticks)
{
    tick += ticks;
    if (auto_ack) mailbox.voice_call_ack = mailbox.voice_call_active;
}
bool e84_network_voice_ready(void) { return network_ready; }
bool m5_link_configured(void) { return true; }
void voice_transport_init(voice_transport_t *link) { memset(link, 0, sizeof(*link)); }
bool voice_transport_server(voice_transport_t *link) { assert(link == &call.server); link->websocket=true; return server_connects; }
bool voice_transport_m5(voice_transport_t *link) { assert(link == &call.m5); return m5_connects; }
void voice_transport_close(voice_transport_t *link) { (void)link; }
bool voice_transport_send(voice_transport_t *link, const voice_header_t *header, const void *payload)
{
    assert(link == &call.server || link == &call.m5);
    assert(sent_count < sizeof(sent) / sizeof(sent[0]));
    assert(header->length <= VOICE_PAYLOAD);
    sent_t *out = &sent[sent_count++];
    out->to_server = link == &call.server;
    out->header = *header;
    if (header->length) { assert(payload); memcpy(out->payload, payload, header->length); }
    if (stop_on_start && header->type == VOICE_CALL_START) stop_requested = true;
    return header->type != failed_send_type;
}
int voice_transport_poll(voice_transport_t *link, voice_packet_t *packet)
{
    if (link == &call.server) {
        if (server_read == server_used) return 0;
        *packet = server_in[server_read++];
    } else {
        assert(link == &call.m5);
        if (m5_read == m5_used) return 0;
        *packet = m5_in[m5_read++];
    }
    return 1;
}

static void reset(void)
{
    memset(&call, 0, sizeof(call));
    memset(&mailbox, 0, sizeof(mailbox));
    memset(sent, 0, sizeof(sent));
    tick = 1000u;
    network_ready = server_connects = m5_connects = auto_ack = true;
    stop_on_start = busy = start_requested = stop_requested = false;
    failed_send_type = 0u;
    server_used = server_read = m5_used = m5_read = sent_count = 0u;
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
static bool from_m5(uint8_t type, uint32_t turn, uint32_t sequence)
{ voice_packet_t p = packet(type, turn, sequence); return m5_packet(&p); }
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
    assert(!from_server(VOICE_LISTEN, 2u, 0u));
    assert(!from_m5(VOICE_PLAYBACK_DONE, 1u, 2u)); /* Data not consumed yet. */
    assert(from_m5(VOICE_AUDIO_ACK, 1u, 2u));
    assert(call.state == PLAYING && mailbox.voice_record_enabled == 0u);
    assert(!from_server(VOICE_LISTEN, 2u, 0u)); /* ACK is not speaker drain. */
    assert(from_m5(VOICE_PLAYBACK_DONE, 1u, 2u));
    assert(call.state == WAIT_LISTEN && mailbox.voice_record_enabled == 0u);
    assert(count_sent(VOICE_PLAYBACK_DONE) == 1u);
    assert(from_server(VOICE_LISTEN, 2u, 0u));
    assert(call.state == LISTEN_DELAY && mailbox.voice_record_enabled == 0u);
    tick += VOICE_SETTLE_MS;
    assert(begin_listen());
    assert(call.state == LISTENING && mailbox.voice_record_enabled == 1u);
    assert(mailbox.voice_listen_seq == call.listen_generation && mailbox.voice_listen_turn == 2u);
    assert(count_sent(VOICE_INPUT_START) == 1u);
}
static void test_stale_and_mismatched_packets(void)
{
    reset();
    output_to_end(false);
    voice_packet_t wrong = packet(VOICE_AUDIO_ACK, 1u, 1u);
    wrong.header.session++;
    assert(!m5_packet(&wrong) && call.output_ack == 0u);
    assert(!from_m5(VOICE_AUDIO_ACK, 0u, 1u));
    assert(!from_m5(VOICE_AUDIO_ACK, 1u, 3u));
    assert(from_m5(VOICE_AUDIO_ACK, 1u, 1u));
    assert(!from_m5(VOICE_AUDIO_ACK, 1u, 1u));
    assert(!from_m5(VOICE_AUDIO_ACK, 1u, 0u));
    assert(!from_m5(VOICE_PLAYBACK_DONE, 1u, 1u));
    assert(from_m5(VOICE_AUDIO_ACK, 1u, 2u));
    assert(!from_m5(VOICE_PLAYBACK_DONE, 2u, 2u));
    assert(from_m5(VOICE_PLAYBACK_DONE, 1u, 2u));
    assert(!from_m5(VOICE_PLAYBACK_DONE, 1u, 2u));
    assert(!from_server(VOICE_LISTEN, 1u, 0u));
    wrong = packet(VOICE_LISTEN, 2u, 0u); wrong.header.session++;
    assert(!server_packet(&wrong));
    assert(call.state == WAIT_LISTEN && mailbox.voice_record_enabled == 0u);
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
    assert(from_m5(VOICE_AUDIO_ACK, 1u, 2u));
    assert(from_m5(VOICE_PLAYBACK_DONE, 1u, 2u));
    assert(!from_server(VOICE_LISTEN, 2u, 0u)); /* Final speech must never resume capture. */
    assert(from_server(VOICE_CALL_END, 1u, 0u));
    assert(call.state == ENDING && mailbox.voice_record_enabled == 0u);
    assert(!from_server(VOICE_LISTEN, 2u, 0u));
    call.may_have_answered = true;
    assert(from_m5(VOICE_CALL_ENDED, 1u, 0u));
    assert(call.state == FINISHED && !call.may_have_answered);
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
    TickType_t speech_start = call.phase;
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
    mailbox.voice_write_seq = E84_VOICE_RING_FRAMES + 1u;
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
static void queue_ready(void)
{
    server_in[server_used++] = packet(VOICE_READY, 0u, 0u);
    m5_in[m5_used++] = packet(VOICE_READY, 0u, 0u);
    m5_in[m5_used++] = packet(VOICE_PONG, 0u, 1u); /* Fresh probe after API setup. */
}
static void test_stop_and_uncertain_shutdown(void)
{
    reset();
    mailbox.voice_call_active = mailbox.voice_call_ack = 0u;
    voice_stream_request_stop();
    assert(stop_requested && !await_ready(&call.server));
    assert(run_call(123u));
    assert(count_sent(VOICE_CALL_START) == 0u);
    assert(mailbox.voice_record_enabled == 0u && mailbox.voice_call_ack == 0u);

    reset();
    mailbox.voice_call_active = mailbox.voice_call_ack = 0u;
    queue_ready();
    stop_on_start = true;
    failed_send_type = VOICE_CANCEL;
    assert(!run_call(123u));
    assert(count_sent(VOICE_CALL_START) == 1u && count_sent(VOICE_CALL_END) == 0u);
    assert(count_sent(VOICE_CANCEL) == 2u); /* Server + M5; no duplicate physical END. */
    assert(mailbox.voice_record_enabled == 0u && mailbox.voice_call_active == 1u);
    assert(mailbox.voice_call_ack == 1u); /* Unknown M5 state keeps microphone/chime muted. */

    reset();
    mailbox.voice_call_active = mailbox.voice_call_ack = 0u;
    queue_ready();
    m5_in[m5_used++] = packet(VOICE_CALL_ENDED, 0u, 0u);
    stop_on_start = true;
    assert(run_call(123u));
    assert(mailbox.voice_call_ack == 0u && mailbox.voice_record_enabled == 0u);

    reset();
    mailbox.voice_call_active = mailbox.voice_call_ack = 0u;
    queue_ready();
    m5_in[1].header.sequence = 0u; /* Stale PONG must not authorize a physical call. */
    assert(run_call(123u));
    assert(count_sent(VOICE_CALL_START) == 0u);
    assert(mailbox.voice_call_ack == 0u && mailbox.voice_record_enabled == 0u);
}
int main(void)
{
    test_wait_for_actual_playback_done();
    test_stale_and_mismatched_packets();
    test_no_reply_and_final_end();
    test_capture_end_boundary_and_failures();
    test_stop_and_uncertain_shutdown();
    puts("PASS: CM33 playback gating, packet identity, final turn, capture errors and safe stop");
    return 0;
}
