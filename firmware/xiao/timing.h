#pragma once
/* One [TIMING] line per call event, for measuring Issue #72's latencies:
 * chime -> greeting heard, and visitor stops talking -> reply heard.
 * ms is this device's monotonic clock (same as the [SERVO] at_ms lines);
 * epoch_ms is the NTP wall clock, 0 before the clock is set, so the line can
 * be matched with server logs. tools/timing_report.py turns them into intervals. */
#include "xlog.h"
#include "field_timing.h"
#include <stdint.h>
#include <sys/time.h>

static inline void timing_mark(const char *event, uint32_t turn, uint32_t now_ms)
{
    struct timeval now;
    long long epoch_ms = 0;
    /* 2023-11-14 or later: anything earlier is an unset clock. */
    if (!gettimeofday(&now, NULL) && now.tv_sec > 1700000000)
        epoch_ms = (long long)now.tv_sec * 1000LL + now.tv_usec / 1000;
    field_timing_event(event,turn,now_ms,epoch_ms);
    xlog("[TIMING] event=%s turn=%lu ms=%lu epoch_ms=%lld\n",
        event, (unsigned long)turn, (unsigned long)now_ms, epoch_ms);
}
