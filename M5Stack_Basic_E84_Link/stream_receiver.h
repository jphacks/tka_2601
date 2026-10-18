#pragma once
#include <stdint.h>

namespace e84stream {
void beginReceiver(uint16_t port, const char* token);
void pollReceiver(bool networkReady, bool confirmStart, bool confirmEnd);
// Local USB console only: one isolated press/return cycle, never a call action.
bool requestServoTest(bool ending, bool useCalibration = false);
bool cancelServoTest();
bool servoTestBusy();
bool servoMotionBusy();
// USB-only calibration protocol. Angles are physical PWM command angles,
// after applying the legacy reversal settings. Saved atomically in ESP32 NVS.
void calibrationCommand(const char* command);
bool calibrationActive();
bool receiverReady();
bool speakerBusy();
const char* receiverStatus();
void logReceiverStatus();
}
