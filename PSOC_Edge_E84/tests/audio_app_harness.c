#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "../source/e84_audio_app.c"

static e84_shared_t mailbox;
static uint32_t input_sequence;
static cy_rslt_t capture_result;
static unsigned deleted_tasks;
static TickType_t mock_tick;

volatile e84_shared_t *e84_shared(void) { return &mailbox; }
void e84_shared_acquire(void) { }
void e84_shared_release(void) { }
cy_rslt_t e84_audio_capture_start(void) { return capture_result; }
bool e84_audio_read(e84_audio_frame_t *frame, uint32_t timeout)
{ (void)frame; (void)timeout; return false; }
void vTaskDelete(void *task) { (void)task; ++deleted_tasks; }
TickType_t xTaskGetTickCount(void) { return mock_tick; }

static void reset(void)
{
    memset(&mailbox, 0, sizeof(mailbox));
    input_sequence = 0u;
    mock_tick = 0u;
    initialize_audio();
}

static void command(char c)
{
    mailbox.command = (uint32_t)c;
    ++mailbox.command_seq;
    service_mailbox();
    assert(mailbox.command_ack == mailbox.command_seq);
}

static void feed(const int16_t *pcm)
{
    e84_audio_frame_t frame = {0};
    frame.sequence = ++input_sequence;
    mock_tick += 20u;
    if (pcm != NULL) memcpy(frame.pcm, pcm, sizeof(frame.pcm));
    process_frame(&frame);
    service_mailbox();
}

static void seed(void)
{
    mailbox.seed[0] = 0x11111111u;
    mailbox.seed[1] = 0x22222222u;
    mailbox.seed[2] = 0x33333333u;
    mailbox.seed_ready = 1u;
}

static void test_queue_and_commands(void)
{
    reset();
    for (unsigned i = 0; i < STARTUP_FRAMES; ++i) feed(NULL);
    command('r');
    for (unsigned i = 0; i < MANUAL_RECORD_FRAMES; ++i) feed(NULL);
    assert(mailbox.queued_count == 1u && mailbox.clip_seq == 0u);
    assert(clips[0].samples == 5u * AUDIO_RATE);
    command('x');
    assert(mailbox.queued_count == 1u); /* cancellation cannot delete recordings */
    for (unsigned i = 1; i < CLIP_QUEUE_LENGTH; ++i)
        enqueue_clip(AUDIO_FRAME, -1.0f, next_serial());
    enqueue_clip(AUDIO_FRAME, -1.0f, next_serial());
    assert(mailbox.queued_count == 5u && mailbox.dropped_clips == 1u);
    seed();
    service_mailbox();
    assert(mailbox.clip_seq == 1u && mailbox.clip_samples == 80000u);
    assert(mailbox.clip_id[0] == mailbox.seed[0] && mailbox.clip_id[3] == 1u);
    assert(mailbox.clip_crc == audio_crc32(mailbox.clip_pcm, mailbox.clip_samples * 2u));
    for (unsigned i = 0; i < 20u; ++i) service_mailbox();
    assert(mailbox.queued_count == 5u && mailbox.clip_seq == 1u);
    mailbox.clip_ack = 99u;
    service_mailbox();
    assert(mailbox.queued_count == 5u); /* unrelated ACK cannot free a clip */
    mailbox.clip_ack = mailbox.clip_seq;
    service_mailbox();
    assert(mailbox.queued_count == 4u && mailbox.clip_seq == 2u && mailbox.clip_id[3] == 2u);
    command('r');
    assert(manual_frames == MANUAL_RECORD_FRAMES);
    input_sequence += 2u;
    feed(NULL);
    assert(manual_frames == 0u && mailbox.dropped_clips == 2u);
    assert(mailbox.queued_count == 4u && ring_buffer.used == AUDIO_FRAME);
    command('r');
    command('x');
    assert(manual_frames == 0u && mailbox.queued_count == 4u);
    command('e');
    assert(mailbox.queued_count == 4u);
    event_pending = true;
    latest_event_serial = 42u;
    latest_event_score = 0.01f;
    latest_event_tick = mock_tick;
    service_mailbox();
    assert(mailbox.event_guard == 2u && mailbox.event_seq == 1u);
    assert(mailbox.event_id[3] == 42u && mailbox.event_id[0] == mailbox.seed[0]);
    assert(mailbox.heartbeat == input_sequence - 2u);
    serial_counter = UINT32_MAX;
    assert(next_serial() == 0u);
}

static void test_reference_to_mailbox(const char *path, unsigned seed_mode)
{
    reset();
    if (seed_mode == 0u) seed();
    for (unsigned i = 0; i < 100u; ++i) feed(NULL);
    FILE *stream = fopen(path, "rb");
    assert(stream != NULL);
    int16_t pcm[AUDIO_FRAME];
    size_t got;
    while ((got = fread(pcm, sizeof(*pcm), AUDIO_FRAME, stream)) != 0u) {
        memset(pcm + got, 0, (AUDIO_FRAME - got) * sizeof(*pcm));
        feed(pcm);
        if (seed_mode == 1u && mailbox.detected_count) { seed(); service_mailbox(); }
    }
    assert(fclose(stream) == 0);
    for (unsigned i = 0; i < 150u; ++i) {
        feed(NULL);
        if (seed_mode == 1u && mailbox.detected_count) { seed(); service_mailbox(); }
    }
    if (seed_mode == 2u) {
        assert(mailbox.detected_count == 1u && mailbox.queued_count == 1u);
        assert(mailbox.event_seq == 0u && mailbox.clip_seq == 0u);
        seed();
        service_mailbox();
    }
    assert(mailbox.detected_count == 1u);
    assert(mailbox.event_seq == (seed_mode == 2u ? 0u : 1u));
    assert(mailbox.queued_count == 1u && mailbox.clip_seq == 1u);
    if (seed_mode != 2u)
        assert(memcmp(mailbox.event_id, mailbox.clip_id, sizeof(mailbox.event_id)) == 0);
    assert(mailbox.clip_id[0] == mailbox.seed[0] && mailbox.clip_id[3] == 1u);
    assert(mailbox.clip_samples > 2u * AUDIO_RATE && mailbox.clip_samples <= AUDIO_CLIP_SAMPLES);
    assert(mailbox.clip_crc == audio_crc32(mailbox.clip_pcm, mailbox.clip_samples * 2u));
    assert(mailbox.clip_score <= audio_reference_threshold());
    mailbox.clip_ack = mailbox.clip_seq;
    service_mailbox();
    assert(mailbox.queued_count == 0u && !clip_in_flight);
}

static void test_ack_and_cancel_arrive_together(void)
{
    reset();
    seed();
    warmup = 0u;
    feed(NULL);
    enqueue_clip(AUDIO_FRAME, -1.0f, next_serial());
    enqueue_clip(AUDIO_FRAME, -1.0f, next_serial());
    service_mailbox();
    assert(mailbox.clip_seq == 1u && mailbox.queued_count == 2u);
    command('r');
    /* Network and console tasks publish independently between audio polls. */
    mailbox.clip_ack = mailbox.clip_seq;
    mailbox.command = 'x';
    ++mailbox.command_seq;
    service_mailbox();
    assert(mailbox.command_ack == mailbox.command_seq && manual_frames == 0u);
    assert(mailbox.queued_count == 1u && mailbox.clip_seq == 2u && mailbox.clip_id[3] == 2u);
    assert(mailbox.clip_ack == 1u); /* Audio may never overwrite CM33's ACK. */
}

static void request_voice(uint32_t generation, uint32_t turn)
{
    mailbox.voice_call_active = 1u;
    service_mailbox();
    assert(mailbox.voice_call_ack == 1u);
    mailbox.voice_listen_turn = turn;
    mailbox.voice_record_enabled = 1u;
    mailbox.voice_listen_seq = generation;
    service_mailbox();
}

static void test_voice_mailbox_and_playback_gate(void)
{
    reset();
    warmup = 0u;
    int16_t pcm[AUDIO_FRAME];
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = 1000;
    mailbox.voice_call_active = 1u; /* Servo/initial greeting: no listen request. */
    service_mailbox();
    assert(mailbox.voice_call_ack == 1u);
    command('r');
    assert(manual_frames == 0u);
    for (unsigned i = 0; i < 100u; ++i) feed(pcm);
    assert(mailbox.voice_write_seq == 0u && ring_buffer.used == 0u);
    request_voice(1u, 1u);
    assert(mailbox.voice_listen_ack == 1u);
    for (unsigned i = 0; i < 3u; ++i) feed(pcm);
    assert(mailbox.voice_write_seq == 3u && mailbox.voice_samples == 960u);
    for (unsigned i = 0; i < 60u; ++i) feed(NULL);
    assert(mailbox.voice_end_listen_seq == 1u && mailbox.voice_end_turn == 1u);
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_SILENCE);
    assert(mailbox.voice_end_seq == 63u && mailbox.voice_samples == 63u * AUDIO_FRAME);
    for (unsigned i = 0; i < 100u; ++i) feed(pcm); /* Waiting/playing stays muted. */
    assert(mailbox.voice_write_seq == 63u && ring_buffer.used == 0u);
    request_voice(2u, 2u);
    assert(mailbox.voice_listen_ack == 1u); /* Must drain old PCM first. */
    mailbox.voice_read_seq = mailbox.voice_write_seq;
    service_mailbox();
    assert(mailbox.voice_listen_ack == 2u);
    for (unsigned i = 0; i < 3u; ++i) feed(pcm);
    assert(mailbox.voice_write_seq == 66u && mailbox.voice_samples == 960u);
    input_sequence += 1u;
    feed(pcm);
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_GAP);
    assert(mailbox.voice_end_listen_seq == 2u && mailbox.voice_end_turn == 2u);
    assert(mailbox.voice_end_seq == 66u);
    mailbox.voice_call_active = 0u;
    mailbox.voice_read_seq = mailbox.voice_write_seq;
    service_mailbox();
    assert(voice_capture.state == VOICE_CAPTURE_IDLE && mailbox.voice_call_ack == 0u);
    feed(NULL);
    assert(ring_buffer.used == AUDIO_FRAME); /* Idle chime detection resumes. */
    request_voice(3u, 1u); /* A later call may reuse turn 1, never its generation. */
    for (unsigned i = 0; i < 65u; ++i) feed(pcm);
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_OVERFLOW);
    assert(mailbox.voice_end_listen_seq == 3u && mailbox.voice_end_turn == 1u);
    assert(mailbox.voice_write_seq - mailbox.voice_read_seq == E84_VOICE_RING_FRAMES);
    assert(mailbox.voice_samples == E84_VOICE_RING_FRAMES * AUDIO_FRAME);
    assert(mailbox.queued_count == 0u);
}

static void test_voice_abandoned_request_not_restarted(void)
{
    reset();
    warmup = 0u;
    /* A listen request abandoned before activation cannot begin a later call. */
    mailbox.voice_listen_seq = 7u;
    mailbox.voice_listen_turn = 1u;
    mailbox.voice_call_active = 1u;
    service_mailbox();
    assert(mailbox.voice_call_ack == 1u && mailbox.voice_listen_ack == 0u);
    service_mailbox();
    assert(voice_capture.state == VOICE_CAPTURE_IDLE);
    request_voice(8u, 1u);
    assert(mailbox.voice_listen_ack == 8u && voice_capture.state == VOICE_CAPTURE_LISTENING);
    mailbox.voice_call_active = 0u;
    service_mailbox();
    assert(mailbox.voice_call_ack == 0u && voice_capture.state == VOICE_CAPTURE_IDLE);
}

static void test_voice_hardware_error_invalidates_audio(void)
{
    reset();
    warmup = 0u;
    request_voice(1u, 1u);
    int16_t pcm[AUDIO_FRAME];
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = 1000;
    for (unsigned i = 0; i < 3u; ++i) feed(pcm);
    e84_audio_frame_t failed = {0};
    failed.sequence = ++input_sequence; /* No sequence gap, but a PDM error. */
    failed.errors = 1u;
    process_frame(&failed);
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_GAP);
    assert(mailbox.voice_end_listen_seq == 1u && mailbox.voice_end_seq == 3u);
    assert(mailbox.capture_errors == 1u && mailbox.voice_samples == 3u * AUDIO_FRAME);
}

static void test_voice_cancel_keeps_chime_and_playback_muted(void)
{
    reset();
    warmup = 0u;
    request_voice(1u, 1u);
    int16_t pcm[AUDIO_FRAME];
    for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = 1000;
    for (unsigned i = 0; i < 3u; ++i) feed(pcm);
    mailbox.voice_record_enabled = 0u;
    service_mailbox();
    assert(mailbox.voice_call_ack == 1u && voice_call_active);
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_CANCELLED);
    assert(mailbox.voice_end_listen_seq == 1u && mailbox.voice_end_seq == 3u);
    for (unsigned i = 0; i < 100u; ++i) feed(pcm);
    assert(mailbox.voice_write_seq == 3u && ring_buffer.used == 0u);
    command('r');
    assert(manual_frames == 0u);
    mailbox.voice_read_seq = mailbox.voice_write_seq;
    mailbox.voice_listen_seq = 2u;
    service_mailbox();
    assert(mailbox.voice_listen_ack == 1u); /* Disabled requests cannot start. */
    mailbox.voice_record_enabled = 1u;
    service_mailbox();
    assert(mailbox.voice_listen_ack == 2u && voice_capture.state == VOICE_CAPTURE_LISTENING);
    for (unsigned i = 0; i < 3u; ++i) feed(pcm);
    assert(mailbox.voice_write_seq == 6u);
    for (unsigned i = 0; i < 60u; ++i) {
        feed(NULL);
        mailbox.voice_read_seq = mailbox.voice_write_seq;
    }
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_SILENCE);
    mailbox.voice_record_enabled = 0u;
    service_mailbox();
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_SILENCE); /* Preserve a valid ending. */
}

static void test_voice_ring_counter_wrap(void)
{
    reset();
    warmup = 0u;
    mailbox.voice_read_seq = mailbox.voice_write_seq = UINT32_MAX - 3u;
    request_voice(1u, 1u);
    int16_t pcm[AUDIO_FRAME];
    for (unsigned n = 0; n < E84_VOICE_RING_FRAMES; ++n) {
        for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = (int16_t)(1000u + n);
        feed(pcm);
    }
    assert(mailbox.voice_write_seq - mailbox.voice_read_seq == E84_VOICE_RING_FRAMES);
    for (unsigned n = 0; n < E84_VOICE_RING_FRAMES; ++n) {
        uint32_t index = (mailbox.voice_read_seq + n) % E84_VOICE_RING_FRAMES;
        assert(mailbox.voice_pcm[index][0] == (int16_t)(1000u + n));
    }
    feed(pcm);
    assert(mailbox.voice_end_reason == VOICE_CAPTURE_END_OVERFLOW);
    assert(mailbox.voice_end_seq == mailbox.voice_write_seq);
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    test_queue_and_commands();
    test_reference_to_mailbox(argv[1], 0u); /* entropy ready on boot */
    test_reference_to_mailbox(argv[1], 1u); /* entropy arrives before event expiry */
    test_reference_to_mailbox(argv[1], 2u); /* old event expires, recording survives */
    test_ack_and_cancel_arrive_together();
    test_voice_mailbox_and_playback_gate();
    test_voice_ring_counter_wrap();
    test_voice_abandoned_request_not_restarted();
    test_voice_hardware_error_invalidates_audio();
    test_voice_cancel_keeps_chime_and_playback_muted();
    capture_result = CY_RSLT_FAILURE;
    e84_audio_task(NULL);
    assert(mailbox.audio_status == 2u && deleted_tasks == 1u);
    puts("PASS: CM55 capture, queue retention/ACK, cancellation, gaps, reference detection and ID/CRC export");
    return 0;
}
