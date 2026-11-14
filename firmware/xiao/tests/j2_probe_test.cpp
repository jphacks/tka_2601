#include "servo_probe.h"
#include "servo_control.h"
#include "voice_stream.h"
#include <Arduino.h>
#include <Preferences.h>

namespace {
bool moving = false, inCall = false;
unsigned motions = 0;
uint8_t stage() {
  Preferences nvs;
  assert(nvs.begin("p1-bench", true));
  return nvs.getUChar("stage", 0);
}
void advance(uint32_t ms) { fake::now += ms; servo_probe_poll(); }
}
extern "C" void xlog(const char*, ...) {}
extern "C" bool voice_stream_busy() { return inCall; }
extern "C" bool voice_stream_recovery_required() { return false; }
extern "C" bool servo_motion_busy() { return moving; }
extern "C" bool servo_test_busy() { return moving; }
extern "C" bool servo_test(char letter) {
  assert(letter == 'c');
  ++motions;
  return moving = true;
}
int main() {
  servo_probe_begin(); advance(6000); assert(motions == 0);
  assert(servo_probe_command("@j2-probe arm")); assert(stage() == 1);
  advance(6000); assert(motions == 0);
  servo_probe_begin(); assert(stage() == 2);
  advance(4999); assert(motions == 0);
  advance(1); assert(motions == 1 && stage() == 3);
  moving = false; advance(1); assert(stage() == 4);
  servo_probe_begin(); advance(5000); assert(motions == 1);
  servo_probe_command("@j2-probe arm"); servo_probe_begin();
  inCall = true; advance(5000); assert(stage() == 5 && motions == 1);
  inCall = false; servo_probe_command("@j2-probe arm");
  fake::failStorage = true; servo_probe_begin(); advance(5000); assert(motions == 1);
  puts("J2 one-shot probe passed");
}
