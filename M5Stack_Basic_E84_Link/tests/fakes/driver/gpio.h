#pragma once
#include <M5Unified.h>
using esp_err_t = int;
constexpr esp_err_t ESP_OK = 0, ESP_FAIL = -1;
using gpio_num_t = int;
constexpr int GPIO_MODE_OUTPUT = 1;
inline esp_err_t gpio_reset_pin(gpio_num_t pin) {
  if (fake::attachedPin == pin) fake::attachedPin = -1;
  fake::signalOutputs[pin] = false;
  return ESP_OK;
}
inline esp_err_t gpio_set_level(gpio_num_t pin, uint32_t level) {
  fake::signalLevels[pin] = level;
  return ESP_OK;
}
inline esp_err_t gpio_set_direction(gpio_num_t pin, int mode) {
  assert(mode == GPIO_MODE_OUTPUT);
  fake::signalOutputs[pin] = true;
  return ESP_OK;
}
