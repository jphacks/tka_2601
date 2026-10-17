#include "stream_receiver.h"
#include "stream_protocol.h"
#include <M5Unified.h>
#include <WiFi.h>
#include <assert.h>

int e84FakeSend(int, const void* data, size_t size, int) {
  const auto* bytes = static_cast<const uint8_t*>(data);
  fake::current->output.insert(fake::current->output.end(), bytes, bytes + size);
  return static_cast<int>(size);
}
using namespace e84stream;
namespace {
const char kToken[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
void tick(uint32_t ms = 2, bool a = false, bool c = false) {
  fake::now += ms; pollReceiver(true, a, c);
}
void enqueue(const std::shared_ptr<fake::Socket>& s, Type type, uint32_t id) {
  Header h; h.type = type; h.session = id;
  if (type == Type::Hello) h.length = 64;
  uint8_t head[kHeaderBytes]; encodeHeader(h, head);
  s->input.insert(s->input.end(), head, head + sizeof(head));
  if (h.length) s->input.insert(s->input.end(), kToken, kToken + 64);
}
bool saw(const std::shared_ptr<fake::Socket>& s, Type type) {
  bool found = false;
  for (size_t offset = 0; offset < s->output.size();) {
    Header h; assert(decodeHeader(s->output.data() + offset, h));
    found |= h.type == type; offset += kHeaderBytes + h.length;
  }
  s->output.clear(); return found;
}
std::shared_ptr<fake::Socket> connect(uint32_t id) {
  auto s = std::make_shared<fake::Socket>(); fake::candidate = s;
  enqueue(s, Type::Hello, id); tick(); assert(saw(s, Type::Ready)); return s;
}
}
int main() {
  beginReceiver(8769, kToken);
  auto s = connect(200);
  enqueue(s, Type::CallStart, 200); tick();
#ifdef TEST_DISABLED
  assert(!s->connected && saw(s, Type::Error));
#else
  assert(s->connected && !saw(s, Type::CallStarted));
  tick(5000); assert(!saw(s, Type::CallStarted));
  tick(2, false, true); assert(!saw(s, Type::CallStarted)); // wrong confirmation button
  tick(2, true, false); assert(saw(s, Type::CallStarted));
  enqueue(s, Type::Cancel, 200); tick();
  assert(s->connected && !saw(s, Type::CallEnded));
  tick(2, true, false); assert(!saw(s, Type::CallEnded));
  tick(2, false, true); assert(saw(s, Type::CallEnded));
  s->connected = false; tick();
  s = connect(201);
  enqueue(s, Type::CallStart, 201); tick();
  enqueue(s, Type::Cancel, 201); tick(); // cancelled before the A acknowledgement
  tick(2, false, true); assert(saw(s, Type::CallEnded));
  s->connected = false; tick();
  s = connect(202);
  enqueue(s, Type::CallStart, 202); tick(); tick(60000);
  assert(!s->connected && saw(s, Type::Error));
#endif
  assert(fake::servoPins.empty() && fake::servoDuties.empty());
  puts("M5 manual/disabled servo receiver checks passed");
}
