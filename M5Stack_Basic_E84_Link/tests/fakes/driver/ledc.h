#pragma once
#include "gpio.h"
constexpr int LEDC_LOW_SPEED_MODE=1, LEDC_CHANNEL_6=6, LEDC_TIMER_0=0;
constexpr int LEDC_TIMER_16_BIT=16, LEDC_AUTO_CLK=0, LEDC_INTR_DISABLE=0;
struct ledc_timer_config_t {
  int speed_mode, duty_resolution, timer_num;
  uint32_t freq_hz;
  int clk_cfg;
};
struct ledc_channel_config_t {
  int gpio_num, speed_mode, channel, intr_type, timer_sel;
  uint32_t duty, hpoint;
};
inline esp_err_t ledc_timer_config(const ledc_timer_config_t* clock) {
  assert(clock->speed_mode==LEDC_LOW_SPEED_MODE && clock->freq_hz==50 &&
         clock->duty_resolution==16 && clock->timer_num==LEDC_TIMER_0);
  return ESP_OK;
}
inline esp_err_t ledc_channel_config(const ledc_channel_config_t* output) {
  assert(output->speed_mode==LEDC_LOW_SPEED_MODE && output->channel==LEDC_CHANNEL_6);
  if (fake::failNextServoAttach) { fake::failNextServoAttach=false; return ESP_FAIL; }
  assert(fake::attachedPin==-1);
  fake::initialPwmDuties.push_back(output->duty);
  fake::retainedPwmDuty=output->duty;
  fake::attachedPin=output->gpio_num;
  fake::servoPins.push_back(output->gpio_num);
  return ESP_OK;
}
// ESP-IDF's atomic duty API requires a separately installed fade service.
// Servo PWM must work without it (M5's service is not installed at boot).
inline esp_err_t ledc_set_duty_and_update(int,int,uint32_t,uint32_t) { return ESP_FAIL; }
inline uint32_t pendingServoDuty=0;
inline esp_err_t ledc_set_duty(int mode,int channel,uint32_t duty) {
  assert(mode==LEDC_LOW_SPEED_MODE && channel==LEDC_CHANNEL_6);
  if (fake::failNextServoWrite) { fake::failNextServoWrite=false; return ESP_FAIL; }
  assert(fake::attachedPin!=-1);
  pendingServoDuty=duty;
  return ESP_OK;
}
inline esp_err_t ledc_update_duty(int mode,int channel) {
  assert(mode==LEDC_LOW_SPEED_MODE && channel==LEDC_CHANNEL_6);
  assert(fake::attachedPin!=-1);
  fake::retainedPwmDuty=pendingServoDuty;
  fake::servoDuties.push_back(pendingServoDuty);
  return ESP_OK;
}
inline esp_err_t ledc_stop(int mode,int channel,uint32_t idle) {
  assert(mode==LEDC_LOW_SPEED_MODE && channel==LEDC_CHANNEL_6 && idle==0);
  assert(fake::attachedPin!=-1);
  fake::stoppedPins.push_back(fake::attachedPin);
  // Hardware stop leaves its previous duty register intact. The next attach
  // must initialize duty=0 instead of replaying this retained target.
  return ESP_OK;
}
