#pragma once
#include <stdint.h>

namespace e84stream {
void beginReceiver(uint16_t port, const char* token);
void pollReceiver(bool networkReady, bool confirmStart, bool confirmEnd);
bool receiverReady();
bool speakerBusy();
const char* receiverStatus();
void logReceiverStatus();
}
