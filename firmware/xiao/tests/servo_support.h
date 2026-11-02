#pragma once
#include "servo_control.h"
#include <Arduino.h>
#include <Preferences.h>
#include <cassert>
#include <cstdarg>
#include <string>
extern "C" void xlog(const char* format, ...) {
  char text[1400];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(text, sizeof(text), format, arguments);
  va_end(arguments);
  fake::serialLines.emplace_back(text);
}
inline void tick(uint32_t ms = 1) { fake::now += ms; servo_poll(); }
inline bool command(const char* text, const char* contains = nullptr) {
  servo_calibration_command(text);
  const std::string reply = fake::serialLines.back();
  assert(reply.find("[CAL] ") == 0);
  if (contains) assert(reply.find(contains) != std::string::npos);
  return reply.find("\"ok\":true") != std::string::npos;
}
inline uint32_t dutyUs(unsigned pulse) { return pulse * 16384u / 20000u; }
inline uint32_t duty(unsigned angle) { return dutyUs(1000u + 1000u * angle / 180u); }
constexpr int kCall = 7, kEnd = 8, kUnlock = 9;
constexpr size_t kStoredBytes = 24;
