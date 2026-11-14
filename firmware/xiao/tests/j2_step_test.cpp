#include "servo_support.h"
int main() {
  servo_begin();
  assert(command("@begin"));
  assert(command("@time d 0"));
  assert(command("@save"));
  for (auto test : {std::pair<char, unsigned>{'c',1700}, {'e',1600}}) {
    const auto before = fake::servoDuties.size();
    assert(servo_test(test.first));
    assert(fake::servoDuties.size() == before+1);
    assert(fake::servoDuties.back() == dutyUs(test.second));
    tick(300);
    assert(fake::servoDuties.size() == before+2);
    assert(fake::servoDuties.back() == dutyUs(1500));
    tick(1000);
    assert(!servo_motion_busy());
  }
  puts("PASS: J2 1700->1500 us; J3 1600->1500 us; one press/return each");
}
