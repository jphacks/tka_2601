#include "stream_receiver.h"
#include "stream_protocol.h"
#include <M5Unified.h>
#include <WiFi.h>
#include <cassert>
#include <string>
using namespace e84stream;
int e84FakeSend(int,const void* p,size_t n,int) {
  const auto* bytes=static_cast<const uint8_t*>(p);
  fake::current->output.insert(fake::current->output.end(),bytes,bytes+n);
  return static_cast<int>(n);
}
const char token[]="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
void tick(uint32_t ms=1) { fake::now+=ms;pollReceiver(true,false,false); }
bool command(const char* text,const char* expected=nullptr) {
  calibrationCommand(text);const auto& reply=fake::serialLines.back();
  if(expected)assert(reply.find(expected)!=std::string::npos);
  return reply.find("\"ok\":true")!=std::string::npos;
}
void packet(const std::shared_ptr<fake::Socket>& s,Type type,uint32_t id,uint32_t turn=0) {
  Header h;h.type=type;h.session=id;h.turn=turn;
  h.length=type==Type::Hello?64:0;
  uint8_t bytes[kHeaderBytes];encodeHeader(h,bytes);
  s->input.insert(s->input.end(),bytes,bytes+sizeof(bytes));
  if(h.length)s->input.insert(s->input.end(),token,token+64);
  tick();
}
void released(int pin) {
  assert(fake::attachedPin==-1);
  assert(!fake::stoppedPins.empty() && fake::stoppedPins.back()==pin);
  assert(fake::signalOutputs[pin] && fake::signalLevels[pin]==0);
  assert(!servoMotionBusy());
}
int main() {
  beginReceiver(8769,token);tick(2000);
  assert(command("@begin"));
  for(const char* c:{"@angles c 180 30","@angles e 32 33","@time d 0","@save"})assert(command(c));
  // Reproduce CALL -> END and repeated END operations with a retained duty
  // register, as in the installed ESP32 core. Every new output starts at zero.
  for(bool ending:{false,true,true}) {
    const auto before=fake::servoDuties.size();
    assert(requestServoTest(ending));
    tick(300);tick(1000);released(ending?17:26);
    assert(fake::servoDuties.size()==before+2);
    assert(!fake::initialPwmDuties.empty() && fake::initialPwmDuties.back()==0);
    const auto attaches=fake::servoPins.size();tick(10000);
    assert(fake::servoPins.size()==attaches);
  }
  auto s=std::make_shared<fake::Socket>();fake::candidate=s;
  packet(s,Type::Hello,99);packet(s,Type::CallStart,99);
  tick(300);tick(1000);released(26);
  const auto before=fake::servoPins.size();
  packet(s,Type::CallEnd,99);
  packet(s,Type::CallEnd,99);packet(s,Type::Cancel,99);packet(s,Type::Cancel,99,1);
  tick(300);packet(s,Type::Cancel,99,2);
  s->connected=false;tick();tick(1000);released(17);tick(10000);
  assert(fake::servoPins.size()==before+1); // END only once, even on disconnect
  auto probe=std::make_shared<fake::Socket>();fake::candidate=probe;
  packet(probe,Type::Hello,99); // an old session cannot repeat END
  tick(10000);assert(fake::servoPins.size()==before+1);
  // Calibration previews belong to the editor, not the completed TCP call.
  assert(command("@begin"));
  assert(command("@set e p 34","\"motion_busy\":true"));
  assert(!command("@test e","receiver_busy"));
  tick(300);
  assert(command("@save")); // does not restart return or queue another press
  tick(1000);released(17);
  assert(std::string(receiverStatus())=="Calibration preview complete: end");
  assert(command("@get","\"motion_busy\":false"));
  const auto count=fake::servoPins.size();tick(10000);
  assert(fake::servoPins.size()==count);
  // A failed return write cannot leave the press output or test-busy latched.
  assert(requestServoTest(true));
  fake::failNextServoWrite=true;
  tick(300);released(17);
  assert(!servoTestBusy());
  assert(command("@get","\"motion_error\":\"servo_return_failed\""));
  const auto failedCount=fake::servoPins.size();tick(10000);
  assert(fake::servoPins.size()==failedCount);
  assert(command("@begin"));assert(command("@time d 2000"));assert(command("@save"));
  assert(requestServoTest(false));
  assert(command("@get","\"motion_error\":\"\""));
  assert(cancelServoTest()); // cancel during delay: no physical CALL press
  assert(requestServoTest(true));tick(300);tick(1000);released(17);
  assert(command("@get","\"motion_error\":\"\""));
  for(auto duty:fake::initialPwmDuties)assert(duty==0);
  puts("M5 release: zero-duty attach, explicit stop/LOW, single END, preview isolation passed");
}
