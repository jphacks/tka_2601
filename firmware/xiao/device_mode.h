#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The household's operating mode, as saved in the app (docs/spec.md 2.3).
 * Zero is deliberately not a mode: it means "nothing decided yet". */
typedef enum { DEVICE_MODE_NORMAL = 1, DEVICE_MODE_OMAKASE, DEVICE_MODE_AWAY, DEVICE_MODE_OFF } device_mode_t;
typedef enum { DEVICE_MODE_PARSE_INVALID, DEVICE_MODE_PARSE_UNPAIRED, DEVICE_MODE_PARSE_OK } device_mode_parse_t;

/* Exact, case-sensitive names; anything else is rejected, never mapped to off. */
bool device_mode_from_name(const char *name, device_mode_t *out);
const char *device_mode_name(device_mode_t mode);
/* Strict parse of GET /device/mode-settings. *out is written only for PARSE_OK. */
device_mode_parse_t device_mode_parse(const uint8_t *json, size_t length, device_mode_t *out);

/* Boot: the last good mode from NVS, else the build-time DOOR_RELAY_MODE. */
void device_mode_init(void);
device_mode_t device_mode_current(void);
/* Mode names the relay protocol accepts; stop mode never reaches the relay. */
const char *device_mode_relay_name(void);
bool device_mode_accepts_calls(void);
/* Pass a chime detection or manual request through only while calls are accepted.
 * Stop mode drops it (never queued) and logs. */
bool device_mode_gate_call(bool requested);
/* Make a fetched mode current and keep it for offline/reboot. The mode is
 * applied even when storage fails (returns false so the caller can report it).
 * The next call retries the save. */
bool device_mode_apply(device_mode_t mode);

/* Storage hooks. device_mode_store.cpp keeps them in NVS. read returns false
 * when nothing valid was ever stored. */
bool device_mode_store_read(uint8_t *value);
bool device_mode_store_write(uint8_t value);

/* Periodic mode fetch and PUT /heartbeat. Called by the network task only. */
void device_mode_sync_step(bool network_ready);
#ifdef __cplusplus
}
#endif
