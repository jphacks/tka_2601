#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
#include <stdint.h>

/* Every function may be called from any task; servo_poll runs the timers. */
void servo_begin(void);
void servo_poll(void);

/* A call owns the servos between open and close. Press requests return at once;
 * servo_call_status reports the completed physical operation. */
typedef enum { SERVO_CALL_PENDING, SERVO_CALL_STARTED, SERVO_CALL_ENDED, SERVO_CALL_FAILED,
               SERVO_CALL_MANUAL_CHECK_REQUIRED } servo_call_status_t;
bool servo_call_open(void);
bool servo_call_press(void);
bool servo_end_press(void);
/* Stop safely: unpressed wait ends with no motion; a started press returns and
 * then END runs once. Repeating this never restarts a physical operation. */
void servo_call_cancel(void);
servo_call_status_t servo_call_status(void);
void servo_call_close(void);

/* Physical IDs 1/2 are the two call pushers; ID 3 remains USB-only unlock.
 * Revision zero describes the migrated local configuration. Cloud revisions
 * start at one. All getters/apply calls serialize with call ownership. */
#define SERVO_PUSHER_SCHEMA_VERSION 1u
typedef struct {
  uint32_t revision;
  uint16_t schema_version;
  uint8_t enabled_mask;
  uint8_t call_start;
  uint8_t call_end;
} servo_pusher_config_t;
typedef enum {
  SERVO_CONFIG_APPLIED, SERVO_CONFIG_UNCHANGED, SERVO_CONFIG_BUSY,
  SERVO_CONFIG_INVALID, SERVO_CONFIG_UNSUPPORTED_SCHEMA,
  SERVO_CONFIG_STALE_REVISION, SERVO_CONFIG_REVISION_CONFLICT,
  SERVO_CONFIG_STORAGE_FAILED, SERVO_CONFIG_RECOVERY_REQUIRED, SERVO_CONFIG_CLOUD_MANAGED
} servo_config_result_t;
bool servo_pusher_get(servo_pusher_config_t *out);
servo_config_result_t servo_pusher_apply(const servo_pusher_config_t *config);
/* Unprovisioned local wiring only: revision must remain zero. Refused after
 * cloud provisioning or any applied cloud revision; never clears pending state. */
servo_config_result_t servo_pusher_apply_local(const servo_pusher_config_t *config);
const char *servo_pusher_result_error(servo_config_result_t result);
uint8_t servo_pusher_pin(uint8_t physical_id); /* UINT8_MAX for unknown ID */
void servo_pusher_set_pending(bool pending);
bool servo_recovery_required(void);
bool servo_recovery_confirm(void); /* Operator has confirmed intercom is idle. */

/* Local USB tests: one isolated press/return cycle, never a call action. */
bool servo_test(char target); /* 'c', 'e' or 'u' */
bool servo_test_cancel(void);
bool servo_test_busy(void);
bool servo_motion_busy(void);
/* USB-only calibration protocol. Angles are physical PWM command angles, after
 * applying the reversal settings. Saved atomically in NVS. */
void servo_calibration_command(const char *command);
bool servo_calibration_active(void);
const char *servo_status(void);
void servo_log_status(void);
#ifdef __cplusplus
}
#endif
