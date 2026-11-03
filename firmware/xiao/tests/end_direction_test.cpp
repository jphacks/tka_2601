#include "servo_support.h"
int main() {
  servo_begin();
  assert(command("@get", "\"end_rest\":0,\"end_press\":30"));
  assert(!command("@mirror e", "begin_required"));
  assert(command("@begin"));
  assert(command("@angles c 180 30"));
  assert(command("@angles e 180 163"));
  assert(command("@angles u 10 40"));
  assert(command("@time d 2000")); assert(command("@time e 400"));
  for (const char* bad : {"@angles e -1 30", "@angles e 30 181", "@angles e 1 2 trailing", "@angles x 1 2", "@mirror c"})
    assert(!command(bad));
  assert(command("@mirror e", "\"end_rest\":0,\"end_press\":17"));
  assert(command("@get", "\"call_rest\":180,\"call_press\":30"));
  assert(command("@get", "\"unlock_rest\":10,\"unlock_press\":40"));
  assert(command("@get", "\"call_delay_ms\":2000"));
  assert(command("@get", "\"end_hold_ms\":400"));
  assert(fake::servoPins.empty() && fake::servoDuties.empty() && fake::storedCalibration.empty());
  assert(command("@mirror e", "\"end_rest\":180,\"end_press\":163"));
  assert(command("@mirror e", "\"end_rest\":0,\"end_press\":17"));
  assert(command("@test e"));
  assert(fake::servoDuties.size() == 1 && fake::servoDuties.back() == duty(17));
  assert(!command("@mirror e", "servo_test_busy"));
  tick(399); assert(fake::servoDuties.size() == 1);
  tick(1); assert(fake::servoDuties.size() == 2 && fake::servoDuties.back() == duty(0));
  tick(1000); assert(!servo_test_busy() && !servo_motion_busy());
  assert(command("@save"));
  assert(fake::storedCalibration.size() == kStoredBytes);
  const auto writes = fake::servoDuties.size();
  servo_begin();
  assert(command("@get", "\"end_rest\":0,\"end_press\":17"));
  assert(command("@get", "\"call_rest\":180,\"call_press\":30"));
  assert(fake::servoDuties.size() == writes); // no motion or double reversal on reload
  assert(servo_test('e'));
  assert(fake::servoDuties.back() == duty(17)); tick(400); tick(1000);
  assert(command("@begin"));
  assert(command("@set e p 20"));
  const auto before = fake::servoDuties.size();
  assert(!command("@mirror e", "servo_busy"));
  assert(!command("@angles e 0 30", "servo_busy"));
  assert(fake::servoDuties.size() == before);
  tick(400); tick(1000); assert(command("@cancel"));
  puts("END direction: opposite defaults, no-motion mirror, CALL/timing isolation, PWM, save/reload and busy rejection passed");
}
