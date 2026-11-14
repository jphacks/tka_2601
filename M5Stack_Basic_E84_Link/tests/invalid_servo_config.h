#pragma once
#include "servo_config.example.h"
#if defined(TEST_INVALID_CALL_ANGLE)
#undef M5_SERVO_CALL_PRESS_DEG
#define M5_SERVO_CALL_PRESS_DEG -1
#elif defined(TEST_INVALID_END_ANGLE)
#undef M5_SERVO_END_PRESS_DEG
#define M5_SERVO_END_PRESS_DEG 181
#elif defined(TEST_INVALID_END)
#undef M5_SERVO_END_REVERSED
#define M5_SERVO_END_REVERSED 2
#else
#undef M5_SERVO_CALL_REVERSED
#define M5_SERVO_CALL_REVERSED -1
#endif
