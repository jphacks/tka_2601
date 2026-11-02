#include "servo_pwm.h"
#include <driver/gpio.h>
#include <driver/ledc.h>

namespace monban_servo {
namespace {
// Servos never move at the same time, so one low-speed channel serves all
// three pins, including an explicit zero duty on every attach.
constexpr auto mode = LEDC_LOW_SPEED_MODE;
constexpr auto channel = LEDC_CHANNEL_0;
constexpr auto timer = LEDC_TIMER_0;
int attachedPin = -1;

bool driveLow(uint8_t pin) {
  const auto gpio = static_cast<gpio_num_t>(pin);
  const bool reset = gpio_reset_pin(gpio) == ESP_OK;
  const bool low = gpio_set_level(gpio, 0) == ESP_OK;
  const bool output = gpio_set_direction(gpio, GPIO_MODE_OUTPUT) == ESP_OK;
  return reset && low && output;
}
}

bool attach(uint8_t pin) {
  if (attachedPin != -1) return false;
  if (!driveLow(pin)) return false;
  ledc_timer_config_t clock{};
  clock.speed_mode = mode;
  clock.duty_resolution = LEDC_TIMER_14_BIT; // the ESP32-S3 maximum
  clock.timer_num = timer;
  clock.freq_hz = 50;
  clock.clk_cfg = LEDC_AUTO_CLK;
  if (ledc_timer_config(&clock) != ESP_OK) return false;
  ledc_channel_config_t output{};
  output.gpio_num = pin;
  output.speed_mode = mode;
  output.channel = channel;
  output.intr_type = LEDC_INTR_DISABLE;
  output.timer_sel = timer;
  output.duty = 0;
  output.hpoint = 0;
  if (ledc_channel_config(&output) != ESP_OK) {
    driveLow(pin);
    return false;
  }
  attachedPin = pin;
  return true;
}

bool write(uint8_t pin, uint32_t duty) {
  // Only the servo control code owns this channel. Plain duty updates need no
  // fade service and command the exact target.
  return attachedPin == pin &&
    ledc_set_duty(mode, channel, duty) == ESP_OK &&
    ledc_update_duty(mode, channel) == ESP_OK;
}

bool detach(uint8_t pin) {
  if (attachedPin != pin) return false;
  // Stop first, then remove the peripheral route and drive LOW.
  const bool stopped = ledc_stop(mode, channel, 0) == ESP_OK;
  const bool low = driveLow(pin);
  attachedPin = -1;
  return stopped && low;
}

bool idle(uint8_t pin) { return attachedPin != pin && driveLow(pin); }
}
