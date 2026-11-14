#pragma once
#include "servo_config.example.h"
// Simulate an old user calibration file with only the shared 45-degree press.
#undef M5_SERVO_CALL_REVERSED
#undef M5_SERVO_END_REVERSED
#undef M5_SERVO_CALL_PRESS_DEG
#undef M5_SERVO_END_PRESS_DEG
