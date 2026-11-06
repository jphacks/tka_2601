#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Records a visitor whose chime was dropped in stop mode as
 * status "missed", end_reason "mode_off", mode "off" (docs/spec.md 5.1) with
 * PUT /functions/v1/device/visits/<uuid>.
 *
 * The queue lives in RAM only: entries are lost on reboot or power loss. The
 * durable queue is Issue #44. */
#define VISIT_REPORT_QUEUE 4u
/* Total sends of one entry (the first plus retries) before it is dropped. */
#define VISIT_REPORT_MAX_ATTEMPTS 6u
/* Chimes closer together than this count as one visitor, like the call cooldown. */
#define VISIT_REPORT_MIN_GAP_MS 20000u
/* A clock earlier than this (2024-01-01 UTC) is an unset RTC, never a chime time. */
#define VISIT_REPORT_EARLIEST_VALID_S 1704067200

typedef struct {
    char id[37];        /* visit UUID, generated on the device: a resend never duplicates */
    char chimed_at[21]; /* YYYY-MM-DDTHH:MM:SSZ */
} visit_report_entry_t;

typedef enum { VISIT_REPORT_QUEUED, VISIT_REPORT_DUPLICATE, VISIT_REPORT_FULL,
               VISIT_REPORT_CLOCK_INVALID, VISIT_REPORT_BAD_UUID } visit_report_enqueue_t;
typedef enum { VISIT_REPORT_SENT, VISIT_REPORT_REJECTED, VISIT_REPORT_RETRY } visit_report_result_t;

bool visit_report_format_time(int64_t unix_seconds, char out[21]);
/* JSON body for PUT visits/<id>; returns its length, or 0 if it does not fit. */
size_t visit_report_body(const visit_report_entry_t *entry, char *out, size_t capacity);

/* Producer (voice task): never blocks. A full queue drops the NEW entry, so
 * the producer never touches entries the network task is sending. The
 * consumer (network task) is the only one that removes entries. */
visit_report_enqueue_t visit_report_enqueue(const char *uuid, int64_t wall_seconds);
/* Called when stop mode dropped a chime or manual request. Safe from the
 * voice task: no I/O, no locks. */
visit_report_enqueue_t visit_report_record_mode_off_at(int64_t wall_seconds, uint32_t now_ms);
void visit_report_record_mode_off(void);

/* Consumer (network task). peek returns the oldest entry when it is due. */
bool visit_report_peek(uint32_t now_ms, visit_report_entry_t *out);
void visit_report_done(uint32_t now_ms, visit_report_result_t result);
unsigned visit_report_pending(void);
unsigned visit_report_dropped(void); /* full queue, invalid clock or exhausted retries */

/* One request per call at most; called by the network task only. */
void visit_report_step(bool network_ready);
#ifdef __cplusplus
}
#endif
