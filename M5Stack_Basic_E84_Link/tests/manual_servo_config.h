#pragma once
#include "servo_config.example.h"
#undef M5_SERVO_ENABLED
#undef M5_SERVO_MANUAL_TEST
#define M5_SERVO_ENABLED 0
#ifdef TEST_DISABLED
#define M5_SERVO_MANUAL_TEST 0
#else
#define M5_SERVO_MANUAL_TEST 1
#endif
