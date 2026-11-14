// Retain the last completed trace across the change from external 5V to USB.
// On the hot path only the voice task touches this bounded RAM buffer.
#include "field_timing.h"
#if defined(ARDUINO_ARCH_ESP32) || defined(FIELD_TIMING_HOST_TEST)
#include "xlog.h"
#include <Preferences.h>
#include <cstring>
namespace {
const char *const events[] = {"call_start", "relay_ready", "call_press_requested", "reply_start",
    "playback_start", "playback_done", "listen_start", "speech_end", "end_press_requested", "call_end"};
struct Event { int64_t epoch; uint32_t ms; uint16_t turn; uint8_t id; uint8_t reserved; };
struct Trace { uint32_t version, count, omitted, reserved; Event entries[48]; };
Trace current{};
}
void field_timing_event(const char *name, uint32_t turn, uint32_t ms, int64_t epoch) {
    unsigned id = 0;
    while (id < sizeof(events)/sizeof(*events) && strcmp(events[id], name)) ++id;
    if (id == sizeof(events)/sizeof(*events)) return;
    if (id == 0) { current = {}; current.version = 1; }
    if (!current.version) return;
    // Reserve the final slot for call_end even on a very eventful call.
    if (current.count >= 48 || (current.count == 47 && id != 9) || turn > UINT16_MAX) {
        ++current.omitted; return;
    }
    current.entries[current.count++] = {epoch, ms, static_cast<uint16_t>(turn), static_cast<uint8_t>(id), 0};
}
void field_timing_save() {
    if (!current.count) return;
    Preferences store;
    const size_t bytes = 16 + current.count * sizeof(Event);
    bool ok = store.begin("monban-trace", false) && store.putBytes("timing", &current, bytes) == bytes;
    store.end(); current.version = 0;
    if (!ok) xlog("[TRACE] timing save failed.\n");
}
void field_timing_print() {
    Trace t{}; Preferences store;
    size_t n = 0;
    if (store.begin("monban-trace", true)) {
        n = store.getBytesLength("timing");
        if (n > sizeof(t) || n < 16 || store.getBytes("timing", &t, n) != n) n = 0;
        store.end();
    }
    if (!n || t.version != 1 || !t.count || t.count > 48 || n != 16 + t.count * sizeof(Event)) {
        xlog("[TRACE] no saved timing trace.\n"); return;
    }
    xlog("[TRACE] last call, events=%u omitted=%u.\n", (unsigned)t.count, (unsigned)t.omitted);
    for (unsigned i=0; i<t.count; ++i) {
        const Event &e=t.entries[i]; if (e.id >= sizeof(events)/sizeof(*events)) return;
        xlog("[TIMING] event=%s turn=%u ms=%lu epoch_ms=%lld\n", events[e.id],
             (unsigned)e.turn, (unsigned long)e.ms, (long long)e.epoch);
    }
}
#endif
