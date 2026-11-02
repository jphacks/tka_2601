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
typedef enum { SERVO_CALL_PENDING, SERVO_CALL_STARTED, SERVO_CALL_ENDED, SERVO_CALL_FAILED } servo_call_status_t;
bool servo_call_open(void);
bool servo_call_press(void);
bool servo_end_press(void);
/* Stop safely: unpressed wait ends with no motion; a started press returns and
 * then END runs once. Repeating this never restarts a physical operation. */
void servo_call_cancel(void);
servo_call_status_t servo_call_status(void);
void servo_call_close(void);

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
