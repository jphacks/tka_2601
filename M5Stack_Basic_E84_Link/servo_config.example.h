#pragma once

// Confirmed calibration for the two button-pushing servos on this M5Stack Basic.
// USB tests and E84/API call actions share these exact compiled settings.
// Copy to servo_config.h to customize. PWM starts only for a call operation
// or an explicit USB servo test.
// Calibrate with the horn removed before mounting it against the buttons.
#define M5_SERVO_ENABLED 1
#define M5_SERVO_MANUAL_TEST 0
#define M5_SERVO_CALL_PIN 26
#define M5_SERVO_END_PIN 17
// Mirror each servo's press AND rest positions within the pulse range.
// 1 reverses direction and changes the physical rest position; 0 is normal.
#define M5_SERVO_CALL_REVERSED 1
// The END servo is mounted opposite to CALL: its initial direction is opposite.
#define M5_SERVO_END_REVERSED 0
// 50 Hz PWM; nominal angles map into this conservative sample pulse range.
// Actual travel depends on the servo. Adapt min/max/angles to its datasheet.
#define M5_SERVO_MIN_US 1000
#define M5_SERVO_MAX_US 2000
#define M5_SERVO_REST_DEG 0
// Legacy fallback; adjust the per-servo values below for this setup.
#define M5_SERVO_PRESS_DEG 45
#define M5_SERVO_CALL_PRESS_DEG 180
#define M5_SERVO_END_PRESS_DEG 30
#define M5_SERVO_PRESS_MS 300
#define M5_SERVO_RETURN_MS 1000
