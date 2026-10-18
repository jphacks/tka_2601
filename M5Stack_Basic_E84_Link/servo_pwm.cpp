#include "servo_pwm.h"
#include <driver/gpio.h>
#include <driver/ledc.h>

namespace e84servo {
namespace {
// M5 Basic's LCD uses high-speed LEDC channel 7. Reserve a separate
// low-speed timer/channel, including an explicit zero duty on every attach.
constexpr auto mode = LEDC_LOW_SPEED_MODE;
constexpr auto channel = LEDC_CHANNEL_6;
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
  clock.duty_resolution = LEDC_TIMER_16_BIT;
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
  // Only the receiver loop owns this channel. The atomic/fade API requires
  // ledc_fade_func_install(), which is absent on the installed M5 core.
  // Plain duty updates need no fade service and command the exact target.
  return attachedPin == pin &&
    ledc_set_duty(mode, channel, duty) == ESP_OK &&
    ledc_update_duty(mode, channel) == ESP_OK;
}

bool detach(uint8_t pin) {
  if (attachedPin != pin) return false;
  // ledcDetach alone retains the channel's duty and does not establish a
  // GPIO idle level. Stop first, then remove the peripheral route and drive LOW.
  const bool stopped = ledc_stop(mode, channel, 0) == ESP_OK;
  const bool low = driveLow(pin);
  attachedPin = -1;
  return stopped && low;
}
}
