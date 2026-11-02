#pragma once
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
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
// USB serial, as seen by console.cpp, on the test process's stdin and stdout.
#include <mutex>
#include <poll.h>
#include <unistd.h>
struct SerialFake {
  std::mutex lock;
  int available() {
    pollfd input{0, POLLIN, 0};
    return poll(&input, 1, 0) > 0 && (input.revents & POLLIN) ? 1 : 0;
  }
  int read() {
    char byte = 0;
    return ::read(0, &byte, 1) == 1 ? byte : -1;
  }
  size_t write(const uint8_t* data, size_t length) {
    std::lock_guard<std::mutex> guard(lock);
    size_t done = 0;
    while (done < length) {
      const ssize_t n = ::write(1, data + done, length - done);
      if (n <= 0) break;
      done += static_cast<size_t>(n);
    }
    return done;
  }
};
inline SerialFake Serial;
