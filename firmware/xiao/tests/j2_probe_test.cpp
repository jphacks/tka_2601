#include "servo_probe.h"
#include "servo_control.h"
#include "voice_stream.h"
#include <Arduino.h>
#include <Preferences.h>

namespace {
bool moving = false, inCall = false;
unsigned motions = 0;
char lastLetter = 0;
uint8_t stage() {
  Preferences nvs;
  assert(nvs.begin("p1-bench", true));
  return nvs.getUChar("stage", 0);
}
void setTarget(uint8_t value) {
  Preferences nvs;
  assert(nvs.begin("p1-bench", false) && nvs.putUChar("target", value) == 1);
}
void advance(uint32_t ms) { fake::now += ms; servo_probe_poll(); }
// One armed boot: the probe asks for exactly one press 5 s after boot, then finishes.
void bootAndRun(char expected) {
  const unsigned before = motions;
  servo_probe_begin(); assert(stage() == 2);
  advance(4999); assert(motions == before);
  advance(1); assert(motions == before + 1 && lastLetter == expected && stage() == 3);
  moving = false; advance(1); assert(stage() == 4);
}
}
extern "C" void xlog(const char*, ...) {}
extern "C" bool voice_stream_busy() { return inCall; }
extern "C" bool voice_stream_recovery_required() { return false; }
extern "C" bool servo_motion_busy() { return moving; }
extern "C" bool servo_test_busy() { return moving; }
extern "C" bool servo_test(char letter) {
  assert(letter == 'c' || letter == 'e');
  lastLetter = letter;
  ++motions;
  return moving = true;
}
int main() {
  // J2: unchanged one-shot behaviour.
  servo_probe_begin(); advance(6000); assert(motions == 0);
  assert(servo_probe_command("@j2-probe arm")); assert(stage() == 1);
  advance(6000); assert(motions == 0);
  bootAndRun('c');
  servo_probe_begin(); advance(5000); assert(motions == 1);
  servo_probe_command("@j2-probe arm"); servo_probe_begin();
  inCall = true; advance(5000); assert(stage() == 5 && motions == 1);
  inCall = false; servo_probe_command("@j2-probe arm");
  fake::failStorage = true; servo_probe_begin(); advance(5000); assert(motions == 1);
  fake::failStorage = false;

  // A reservation stored by the J2-only firmware has no target key and still means J2.
  fake::preferenceRecords.erase("p1-bench/target");
  servo_probe_command("@j2-probe arm");
  fake::preferenceRecords.erase("p1-bench/target");
  bootAndRun('c');

  // J3 reaches the END servo, once, and a later J2 reservation goes back to J2.
  assert(servo_probe_command("@j3-probe arm")); assert(stage() == 1);
  bootAndRun('e');
  servo_probe_begin(); advance(5000); assert(motions == 3);
  assert(servo_probe_command("@j2-probe arm"));
  bootAndRun('c');

  // If the target cannot be stored, nothing is armed.
  fake::failWriteKey = "target";
  assert(servo_probe_command("@j3-probe arm")); assert(stage() == 4);
  fake::failWriteKey.clear();

  // An unreadable or foreign target is skipped, never mapped to some servo.
  servo_probe_command("@j3-probe arm"); setTarget('u');
  servo_probe_begin(); advance(5000); assert(stage() == 5 && motions == 4);

  // Status and unknown subcommands.
  assert(servo_probe_command("@j3-probe status"));
  assert(!servo_probe_command("@j3-probe fire"));
  assert(!servo_probe_command("@j4-probe arm"));
  puts("J2/J3 one-shot probe passed");
}
