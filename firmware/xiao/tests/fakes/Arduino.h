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
