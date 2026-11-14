#include "servo_support.h"
int main() {
  servo_begin();
  assert(!servo_motion_busy());
  assert(command("@begin"));
  for (const auto* c : {"@time d 0", "@time c 400", "@time e 500", "@time u 600", "@time r 700"}) assert(command(c));
  for (const auto* c : {"@set c r 160", "@set c p 35", "@set e r 150", "@set e p 65", "@set u r 20", "@set u p 90"}) {
    assert(command(c)); tick(1600); tick(700);
  }
  assert(command("@save", "\"settings_source\":\"saved\""));
  auto saved = fake::storedCalibration;
  const auto operations = fake::servoPins.size();
  servo_begin();
  assert(fake::servoPins.size() == operations);
  assert(command("@get", "\"saved\":{\"call_rest\":160,\"call_press\":35"));
  // Exactly two PWM writes per cycle: the saved press and the saved rest.
  struct Case { char letter; unsigned hold, press, rest; int pin; };
  for (const Case c : {Case{'c', 400, 35, 160, kCall}, Case{'e', 500, 65, 150, kEnd}, Case{'u', 600, 90, 20, kUnlock}}) {
    const auto before = fake::servoDuties.size();
    assert(servo_test(c.letter));
    assert(servo_motion_busy() && fake::attachedPin == c.pin);
    assert(fake::servoDuties.size() == before + 1);
    assert(fake::servoDuties.back() == duty(c.press));
    tick(c.hold - 1);
    assert(fake::servoDuties.size() == before + 1);
    assert(!command("@begin", "servo_test_busy"));
    assert(!command("@set c p 0", "servo_test_busy"));
    tick(1);
    assert(fake::servoDuties.size() == before + 2);
    assert(fake::servoDuties.back() == duty(c.rest));
    tick(699); assert(fake::attachedPin != -1);
    tick(1); assert(fake::attachedPin == -1 && !servo_test_busy());
    assert(!servo_motion_busy());
    assert(fake::servoDuties.size() == before + 2 && fake::storedCalibration == saved);
  }
  // A second preview cannot deepen the press during its hold/return. Saving
  // during return must not issue a third target or prolong that return.
  assert(command("@begin"));
  assert(command("@set c p 50"));
  const auto before = fake::servoDuties.size();
  assert(!command("@set c p 0", "servo_busy"));
  tick(399); assert(fake::servoDuties.size() == before);
  tick(1); assert(fake::servoDuties.size() == before + 1);
  assert(!command("@set c p 0", "servo_busy"));
  tick(350); assert(command("@save"));
  assert(fake::servoDuties.size() == before + 1);
  tick(349); assert(fake::attachedPin == kCall);
  tick(1); assert(fake::attachedPin == -1);
  assert(command("@get", "\"call_press\":50"));
  puts("exact servo: saved readback, exact press/hold/rest, no deeper/repeated writes, no return extension passed");
}
