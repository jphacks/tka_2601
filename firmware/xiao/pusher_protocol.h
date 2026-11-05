#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "servo_control.h"
#include <stddef.h>
#include <stdint.h>
typedef enum { PUSHER_SETTINGS_INVALID, PUSHER_SETTINGS_UNPAIRED,
               PUSHER_SETTINGS_MISSING, PUSHER_SETTINGS_LOCAL, PUSHER_SETTINGS_CONFIG } pusher_settings_result_t;
pusher_settings_result_t pusher_settings_parse(const uint8_t *json, size_t length, servo_pusher_config_t *out);
/* Report the actual local mapping, never the uncommitted desired mapping.
 * actual == NULL reports only capabilities/runtime/error after unreadable storage. */
size_t pusher_status_encode(char *out, size_t capacity, const servo_pusher_config_t *actual,
                           const char *apply_error, bool recovery, unsigned pin1, unsigned pin2);
#ifdef __cplusplus
}
#endif
