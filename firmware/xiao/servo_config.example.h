#pragma once

// Starting values; the USB calibration UI saves the real ones in NVS.
// Copy to servo_config.h to customize. PWM starts only for a call operation or
// an explicit USB servo test. Calibrate with the horn removed before mounting.
// 1 reverses direction and changes the physical rest position; 0 is normal.
#define XIAO_SERVO_CALL_REVERSED 1
#define XIAO_SERVO_END_REVERSED 0
#define XIAO_SERVO_UNLOCK_REVERSED 0
// 50 Hz PWM; nominal angles map into this conservative pulse range. Taken from
// the M5 build (SG90); check against the FS0307 before relying on the travel.
#define XIAO_SERVO_MIN_US 1000
#define XIAO_SERVO_MAX_US 2000
#define XIAO_SERVO_REST_DEG 0
// The rack moves 4.5 mm x angle in radians, so 30 degrees is 2.4 mm of its 4 to 5 mm travel.
#define XIAO_SERVO_CALL_PRESS_DEG 30
#define XIAO_SERVO_END_PRESS_DEG 30
#define XIAO_SERVO_UNLOCK_PRESS_DEG 30
#define XIAO_SERVO_PRESS_MS 300
#define XIAO_SERVO_RETURN_MS 1000
