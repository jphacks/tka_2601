#pragma once

// Sample chosen for two separate button-pushing servos on M5Stack Basic.
// Copy to servo_config.h to customize. No PWM is sent until a call operation.
// Calibrate with the horn removed before mounting it against the buttons.
#define M5_SERVO_ENABLED 1
#define M5_SERVO_MANUAL_TEST 0
#define M5_SERVO_CALL_PIN 26
#define M5_SERVO_END_PIN 17
// 50 Hz PWM; nominal angles map into this conservative sample pulse range.
// Actual travel depends on the servo. Adapt min/max/angles to its datasheet.
#define M5_SERVO_MIN_US 1000
#define M5_SERVO_MAX_US 2000
#define M5_SERVO_REST_DEG 0
#define M5_SERVO_PRESS_DEG 45
#define M5_SERVO_PRESS_MS 500
#define M5_SERVO_RETURN_MS 500
