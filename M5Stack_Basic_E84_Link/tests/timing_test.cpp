#include "stream_receiver.h"
#include "stream_protocol.h"
#include <M5Unified.h>
#include <Preferences.h>
#include <WiFi.h>
#include <cassert>
#include <string>
using namespace e84stream;
int e84FakeSend(int, const void* data, size_t n, int) {
  const auto* p=static_cast<const uint8_t*>(data);
  fake::current->output.insert(fake::current->output.end(),p,p+n); return static_cast<int>(n);
}
const char token[]="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
void tick(uint32_t ms=1) { fake::now+=ms; pollReceiver(true,false,false); }
bool command(const char* text,const char* expected=nullptr) {
  calibrationCommand(text); const auto& line=fake::serialLines.back();
  if(expected) assert(line.find(expected)!=std::string::npos);
  return line.find("\"ok\":true")!=std::string::npos;
}
void packet(const std::shared_ptr<fake::Socket>& s,Type type,uint32_t id) {
  Header h; h.type=type; h.session=id; h.length=type==Type::Hello?strlen(token):0;
  uint8_t bytes[kHeaderBytes]; encodeHeader(h,bytes);
  s->input.insert(s->input.end(),bytes,bytes+sizeof(bytes));
  if(h.length) s->input.insert(s->input.end(),token,token+h.length);
  tick();
}
bool saw(const std::shared_ptr<fake::Socket>& s,Type type) {
  bool found=false;
  for(size_t i=0;i<s->output.size();) { Header h; assert(decodeHeader(s->output.data()+i,h)); found|=h.type==type; i+=kHeaderBytes+h.length; }
  s->output.clear(); return found;
}
std::shared_ptr<fake::Socket> connect(uint32_t id) {
  auto s=std::make_shared<fake::Socket>(); fake::candidate=s;
  packet(s,Type::Hello,id); assert(saw(s,Type::Ready)); return s;
}
int main() {
  const uint16_t legacy[]={1,180,30,180,0};
  const auto* bytes=reinterpret_cast<const unsigned char*>(legacy);
  fake::storedLegacy.assign(bytes,bytes+sizeof(legacy));
  beginReceiver(8769,token); tick(2000);
  assert(command("@get","\"call_press\":30"));
  assert(command("@get","\"call_delay_ms\":3000"));
  assert(command("@get","\"call_hold_ms\":300"));
  assert(command("@get","\"return_ms\":1000"));
  assert(fake::servoPins.empty());
  assert(!command("@time d 1","begin_required"));
  assert(command("@begin"));
  for(const char* text:{"@time d -1","@time d 30001","@time c 99","@time c 2001","@time e 0","@time r 3001","@time x 1","@time c 200 trailing"})
    assert(!command(text,"invalid_timing"));
  for(const char* text:{"@time d 2000","@time c 200","@time e 100","@time r 600","@save"}) assert(command(text));
  assert(fake::servoPins.empty() && fake::storedCalibration.size()==18);
  beginReceiver(8769,token);
  assert(command("@get","\"call_hold_ms\":200"));
  assert(command("@get","\"end_press\":0"));
  auto s=connect(1); packet(s,Type::CallStart,1);
  tick(999); packet(s,Type::CallStart,1); tick(999);
  assert(fake::servoPins.empty() && !saw(s,Type::CallStarted));
  tick(1); assert(fake::attachedPin==26 && fake::servoPins.size()==1);
  const auto pressed=fake::servoDuties.back(); tick(198); packet(s,Type::CallStart,1);
  assert(fake::servoDuties.back()==pressed); tick(1);
  assert(fake::servoDuties.back()==6553); // returned to stored 180 degrees
  tick(599); assert(!saw(s,Type::CallStarted));
  tick(1); assert(fake::attachedPin==-1 && saw(s,Type::CallStarted));
  packet(s,Type::CallStart,1); assert(saw(s,Type::CallStarted) && fake::servoPins.size()==1);
  packet(s,Type::Cancel,1); tick(100); tick(600);
  assert(saw(s,Type::CallEnded)); s->connected=false; tick();
  const auto operations=fake::servoPins.size();
  s=connect(2); packet(s,Type::CallStart,2); tick(1000); packet(s,Type::Cancel,2);
  assert(saw(s,Type::CallEnded) && fake::servoPins.size()==operations);
  s->connected=false; tick(); tick(5000); assert(fake::servoPins.size()==operations);
  s=connect(3); packet(s,Type::CallStart,3); tick(1000); s->connected=false; tick(); tick(5000);
  assert(fake::servoPins.size()==operations); // disconnect before press does not press END
  assert(command("@begin")); assert(command("@time d 30000")); assert(command("@save"));
  s=connect(4); packet(s,Type::CallStart,4); tick(29999); assert(fake::servoPins.size()==operations);
  packet(s,Type::Cancel,4); // at the deadline: return the started press, then END once
  tick(600); tick(100); tick(600); s->connected=false; tick();
  // Preview also performs one bounded press and return, without a network call.
  assert(command("@begin")); assert(command("@set c p 30"));
  tick(199); assert(fake::attachedPin==26); tick(1); assert(fake::servoDuties.back()==6553);
  tick(600); assert(fake::attachedPin==-1); assert(command("@cancel"));
  // UI diagnostics use unsaved values, remain in calibration, and never save.
  const auto saved = fake::storedCalibration;
  assert(command("@begin")); assert(command("@time d 2000"));
  assert(command("@time c 200")); assert(command("@test c", "\"test_busy\":true"));
  assert(calibrationActive());
  assert(!command("@test e", "receiver_busy"));
  assert(!command("@save", "servo_test_busy"));
  assert(!command("@time d 0", "servo_test_busy"));
  auto count = fake::servoPins.size();
  assert(command("@stop", "\"test_busy\":false"));
  tick(3000); assert(fake::servoPins.size()==count); // cancel during delay
  assert(command("@test c")); tick(2000);
  assert(fake::attachedPin==26); tick(200); tick(600);
  assert(!servoTestBusy() && calibrationActive() && fake::attachedPin==-1);
  assert(command("@test e")); assert(fake::attachedPin==17);
  assert(command("@stop")); tick(600);
  assert(!servoTestBusy() && fake::attachedPin==-1);
  count=fake::servoPins.size(); tick(5000);
  assert(fake::servoPins.size()==count && fake::storedCalibration==saved);
  assert(!command("@stop", "test_not_running"));
  assert(command("@cancel"));
  puts("M5 timing: migration, persistence, delayed single press/release, duplicate/cancel/disconnect and preview passed");
}
