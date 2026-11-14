#include "stream_receiver.h"
#include <M5Unified.h>
#include <Preferences.h>
#include <WiFi.h>
#include <cassert>
#include <string>
using namespace e84stream;
int e84FakeSend(int, const void*, size_t n, int) { return static_cast<int>(n); }
void tick(uint32_t ms) { fake::now+=ms; pollReceiver(true,false,false); }
bool command(const char* text,const char* contains=nullptr) {
  calibrationCommand(text); const auto& result=fake::serialLines.back();
  if(contains) assert(result.find(contains)!=std::string::npos);
  return result.find("\"ok\":true")!=std::string::npos;
}
uint32_t duty(unsigned angle) {return (1000u+1000u*angle/180u)*65536u/20000u;}
int main() {
  beginReceiver(8769,"0123456789abcdef0123456789abcdef");
  assert(!servoMotionBusy());
  assert(command("@begin"));
  for(const auto* c:{"@time d 0","@time c 400","@time e 500","@time r 700"}) assert(command(c));
  for(const auto* c:{"@set c r 160","@set c p 35","@set e r 150","@set e p 65"}) {
    assert(command(c)); tick(1600); tick(700);
  }
  assert(command("@save","\"settings_source\":\"saved\""));
  auto saved=fake::storedCalibration;
  const auto operations=fake::servoPins.size();
  beginReceiver(8769,"0123456789abcdef0123456789abcdef");
  assert(fake::servoPins.size()==operations);
  assert(command("@get","\"saved\":{\"call_rest\":160,\"call_press\":35"));
  // Exactly two PWM writes per cycle: the saved press and the saved rest.
  for(bool ending:{false,true}) {
    const auto before=fake::servoDuties.size();
    const auto hold=ending?500:400;
    assert(requestServoTest(ending));
    assert(servoMotionBusy());
    assert(fake::servoDuties.size()==before+1);
    assert(fake::servoDuties.back()==duty(ending?65:35));
    tick(hold-1);
    assert(fake::servoDuties.size()==before+1);
    assert(!command("@begin","servo_test_busy"));
    assert(!command("@set c p 0","servo_test_busy"));
    tick(1);
    assert(fake::servoDuties.size()==before+2);
    assert(fake::servoDuties.back()==duty(ending?150:160));
    tick(699); assert(fake::attachedPin!=-1);
    tick(1); assert(fake::attachedPin==-1 && !servoTestBusy());
    assert(!servoMotionBusy());
    assert(fake::servoDuties.size()==before+2 && fake::storedCalibration==saved);
  }
  // A second preview cannot deepen the press during its hold/return. Saving
  // during return must not issue a third target or prolong that return.
  assert(command("@begin"));
  assert(command("@set c p 50"));
  const auto before=fake::servoDuties.size();
  assert(!command("@set c p 0","servo_busy"));
  tick(399); assert(fake::servoDuties.size()==before);
  tick(1); assert(fake::servoDuties.size()==before+1);
  assert(!command("@set c p 0","servo_busy"));
  tick(350); assert(command("@save"));
  assert(fake::servoDuties.size()==before+1);
  tick(349); assert(fake::attachedPin==26);
  tick(1); assert(fake::attachedPin==-1);
  assert(command("@get","\"call_press\":50"));
  puts("M5 exact servo: saved readback, exact press/hold/rest, no deeper/repeated writes, no return extension passed");
}
