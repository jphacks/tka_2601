#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <deque>
#include <vector>
#include <cassert>
#include <string>

namespace fake {
inline uint32_t now = 10000;
inline std::vector<int> servoPins;
inline std::vector<uint32_t> servoDuties;
inline std::vector<uint32_t> initialPwmDuties;
inline std::vector<int> stoppedPins;
inline int signalLevels[40] = {};
inline bool signalOutputs[40] = {};
inline uint32_t retainedPwmDuty = 0;
inline int attachedPin = -1;
inline bool failNextServoAttach = false, failNextServoWrite = false;
inline std::vector<std::string> serialLines;
}
inline uint32_t millis() { return fake::now; }
inline bool ledcAttachChannel(uint8_t pin, uint32_t, uint8_t, uint8_t) {
  if (fake::failNextServoAttach) { fake::failNextServoAttach = false; return false; }
  fake::attachedPin = pin; fake::servoPins.push_back(pin); return true;
}
inline bool ledcWrite(uint8_t pin, uint32_t duty) {
  if (fake::failNextServoWrite) { fake::failNextServoWrite = false; return false; }
  assert(fake::attachedPin == pin); fake::servoDuties.push_back(duty); return true;
}
inline bool ledcDetach(uint8_t pin) { assert(fake::attachedPin == pin); fake::attachedPin = -1; return true; }
struct SerialFake {
void printf(const char* text) { fake::serialLines.emplace_back(text); }
template<typename... Args> void printf(const char* format, Args... args) {
  char text[1024]; snprintf(text, sizeof(text), format, args...); fake::serialLines.emplace_back(text);
} };
inline SerialFake Serial;
struct SpeakerFake {
  struct Config { uint32_t sample_rate = 48000; size_t dma_buf_len = 0, dma_buf_count = 0; };
  struct Request { const int16_t* data; size_t count; };
  Config configuration;
  std::deque<Request> requests;
  bool enabled = false;
  unsigned starts = 0, ends = 0;
  Config config() { return configuration; }
  void config(Config c) { configuration = c; }
  void setVolume(unsigned) {}
  bool begin() { enabled = true; return true; }
  void end() { ++ends; requests.clear(); enabled = false; }
  size_t isPlaying(uint8_t) { return requests.size(); }
  bool playRaw(const int16_t* pcm, size_t count, uint32_t rate, bool stereo,
               uint32_t repeat, int channel, bool stop) {
    assert(enabled && requests.size() < 2 && count && rate == 16000);
    assert(!stereo && repeat == 1 && channel == 0 && !stop);
    requests.push_back({pcm, count}); ++starts; return true;
  }
};
struct M5Fake { SpeakerFake Speaker; };
inline M5Fake M5;
