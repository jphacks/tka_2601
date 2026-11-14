#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#if defined(ARDUINO_ARCH_ESP32) || defined(FIELD_TIMING_HOST_TEST)
void field_timing_event(const char *event, uint32_t turn, uint32_t ms, int64_t epoch_ms);
void field_timing_save(void);
void field_timing_print(void);
#else
static inline void field_timing_event(const char *event, uint32_t turn, uint32_t ms, int64_t epoch_ms)
{ (void)event; (void)turn; (void)ms; (void)epoch_ms; }
static inline void field_timing_save(void) {}
static inline void field_timing_print(void) {}
#endif
#ifdef __cplusplus
}
#endif
