#include "stream_receiver.h"
#include <M5Unified.h>
#include <Preferences.h>
#include <WiFi.h>
#include <cassert>
#include <string>

int e84FakeSend(int, const void*, size_t size, int) { return static_cast<int>(size); }
using namespace e84stream;
bool command(const char* text, const char* contains = nullptr) {
  calibrationCommand(text);
  const std::string reply = fake::serialLines.back();
  assert(reply.find("[CAL] ") == 0);
  if (contains) assert(reply.find(contains) != std::string::npos);
  return reply.find("\"ok\":true") != std::string::npos;
}
void tick(uint32_t ms) { fake::now += ms; pollReceiver(true, false, false); }
int main() {
  beginReceiver(8769, "0123456789abcdef0123456789abcdef");
  assert(command("@get", "\"call_press\":0"));
  assert(fake::servoPins.empty());
  assert(!command("@set c p 45", "begin_required"));
  assert(command("@begin") && calibrationActive());
  for (const char* cmd : {"@time d 0", "@time c 500", "@time e 500", "@time r 500"}) assert(command(cmd));
  assert(fake::servoPins.empty());
  assert(!requestServoTest(false));
  for (const char* bad : {"@set c p -1", "@set c p 181", "@set c p 30 trailing", "@set x p 50", "@set c x 50"})
    assert(!command(bad, "invalid_command"));
  assert(fake::servoPins.empty());
  auto peer = std::make_shared<fake::Socket>(); fake::candidate = peer; tick(1);
  assert(!peer->connected); // calibration blocks new calls
  assert(command("@set c r 160"));
  assert(fake::attachedPin == 26 && fake::servoDuties.back() == (1888u * 65536u / 20000u));
  assert(!command("@set c p 25", "servo_busy"));
  tick(1500); tick(500);
  assert(command("@set c p 25"));
  assert(!command("@set e p 145", "returning_previous_servo"));
  tick(499); assert(fake::attachedPin == 26);
  tick(1); assert(fake::attachedPin == -1);
  assert(command("@set e p 145"));
  tick(1500); assert(fake::attachedPin == 17); // returns to saved rest, then detaches
  tick(500); assert(fake::attachedPin == -1);
  fake::failStorage = true;
  assert(!command("@save", "storage_unavailable") && calibrationActive());
  assert(fake::storedCalibration.empty());
  fake::failStorage = false;
  assert(command("@save") && !calibrationActive());
  assert(fake::storedCalibration.size() == 18);
  assert(command("@begin"));
  assert(command("@set c p 40"));
  assert(command("@cancel", "\"call_press\":25"));
  tick(500); assert(fake::attachedPin == -1);
  assert(requestServoTest(false));
  assert(fake::servoDuties.back() == (1138u * 65536u / 20000u));
  tick(500); assert(fake::servoDuties.back() == (1888u * 65536u / 20000u));
  tick(500);
  assert(command("@begin")); assert(command("@set c p 55"));
  tick(120000); assert(!calibrationActive()); tick(500);
  assert(command("@get", "\"call_press\":25"));
  // Reloading committed NVS data retains all four angles, with no startup PWM.
  const size_t operations = fake::servoPins.size();
  beginReceiver(8769, "0123456789abcdef0123456789abcdef");
  assert(command("@get", "\"end_press\":145"));
  assert(fake::servoPins.size() == operations);
  // A failure to drive PWM cannot silently replace a calibrated angle.
  assert(command("@begin")); fake::failNextServoWrite = true;
  assert(!command("@set c p 77", "pwm_write_failed"));
  assert(command("@get", "\"call_press\":25"));
  assert(command("@cancel")); tick(500);
  puts("M5 calibration: bounds, isolation, return, persistence, cancel and timeout passed");
}
