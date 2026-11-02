#pragma once
#include <stdint.h>

namespace monban_servo {
constexpr uint32_t kDutySteps = 1u << 14;
// The initial duty is always zero; no previous pin's pulse is replayed.
bool attach(uint8_t pin);
bool write(uint8_t pin, uint32_t duty);
// Stop the peripheral and leave the signal pin driven LOW.
bool detach(uint8_t pin);
// Boot state of a signal pin: driven LOW, no PWM.
bool idle(uint8_t pin);
}
