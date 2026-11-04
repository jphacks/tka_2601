#include "servo_support.h"
#include "pusher_sync.h"
#include "net_stream.h"
#include <algorithm>
#include <deque>
#include <string>
#include <vector>

struct net_stream { std::string response, request; size_t offset = 0; };
static std::deque<std::string> responses;
static std::vector<std::string> requests;
static bool voiceBusy = false;
static bool acquireCallDuringGet = false;
extern "C" bool voice_stream_busy(void) { return voiceBusy; }
extern "C" bool voice_stream_recovery_required(void) { return servo_recovery_required(); }
extern "C" net_stream_t* net_stream_open(const char* host, uint16_t port, const char* ca) {
  assert(std::string(host) == "settings.example.test" && port == 443 && std::string(ca) == "test-device-settings-ca");
  assert(!responses.empty());
  auto* stream = new net_stream{responses.front(), "", 0}; responses.pop_front();
  if (acquireCallDuringGet) { acquireCallDuringGet = false; assert(servo_call_open()); }
  return stream;
}
extern "C" int net_stream_write(net_stream_t* stream, const void* data, size_t length) {
  const size_t count = std::min<size_t>(19, length);
  stream->request.append(static_cast<const char*>(data), count);
  return static_cast<int>(count);
}
extern "C" int net_stream_read(net_stream_t* stream, void* data, size_t capacity) {
  if (stream->offset == stream->response.size()) return -1;
  const size_t count = std::min({capacity, size_t(13), stream->response.size() - stream->offset});
  memcpy(data, stream->response.data() + stream->offset, count); stream->offset += count;
  return static_cast<int>(count);
}
extern "C" void net_stream_close(net_stream_t* stream) { requests.push_back(stream->request); delete stream; }
extern "C" uint32_t net_now_ms(void) { return fake::now; }
extern "C" void net_sleep_ms(uint32_t ms) { fake::now += ms; }

static std::string http(const std::string& body, unsigned status = 200) {
  return "HTTP/1.1 " + std::to_string(status) + " Test\r\nContent-Type: application/json\r\nContent-Length: " +
    std::to_string(body.size()) + "\r\n\r\n" + body;
}
static std::string settings(unsigned revision, unsigned id) {
  const auto p = std::to_string(id);
  return "{\"contract_version\":1,\"paired\":true,\"mode\":\"normal\",\"pusher_settings\":{\"desired_revision\":" +
    std::to_string(revision) + ",\"desired_config\":{\"schema_version\":1,\"enabled_pushers\":[\"p" + p +
    "\"],\"assignments\":{\"call_start\":\"p" + p + "\",\"call_end\":\"p" + p + "\"}}}}";
}
static servo_pusher_config_t actual() { servo_pusher_config_t c{}; assert(servo_pusher_get(&c)); return c; }
static std::string body(const std::string& request) {
  const size_t end = request.find("\r\n\r\n"); assert(end != std::string::npos);
  return request.substr(end + 4);
}
static void sync(const std::string& getResponse, const std::string& putResponse = http("{}"), bool report = true) {
  responses.push_back(getResponse); if (report) responses.push_back(putResponse);
  fake::now += 60001; pusher_sync_step(true); assert(responses.empty());
}
static const std::string& report() {
  assert(requests.back().find("PUT /functions/v1/device/pusher-status HTTP/1.1") == 0);
  return requests.back();
}
static void reported(unsigned revision, const char* error = "null") {
  const auto json = body(report());
  assert(json.find("\"applied_revision\":" + std::to_string(revision)) != std::string::npos);
  if (json.find(std::string("\"apply_error\":") + error) == std::string::npos)
    fprintf(stderr, "expected apply_error=%s in %s\n", error, json.c_str());
  assert(json.find(std::string("\"apply_error\":") + error) != std::string::npos);
}
int main() {
  servo_begin();
  assert(command("@begin") && command("@time d 0") && command("@time c 100") &&
         command("@time e 100") && command("@time r 100") && command("@save"));
  const auto operations = fake::servoPins.size();
  // The first response is applied through the real servo validator/journal.
  sync(http(settings(1, 1)));
  assert(actual().revision == 1 && actual().enabled_mask == 1 && actual().call_end == 1);
  reported(1);
  assert(body(report()).find("\"gpio\":7") != std::string::npos);
  assert(body(report()).find("\"gpio\":8") != std::string::npos);
  for (const auto& request : requests) {
    assert(request.find("Authorization: Bearer test-device-key\r\n") != std::string::npos);
    assert(request.find("apikey: test-publishable-key\r\n") != std::string::npos);
    assert(request.find("test-only-00000000000000000000000000000000") == std::string::npos);
  }
  assert(requests.front().find("GET /functions/v1/device/pusher-settings HTTP/1.1") == 0);
  assert(fake::servoPins.size() == operations);
  // A dropped cloud ACK is retried from readback, without another NVS write.
  const auto writes = fake::storageWrites;
  sync(http(settings(1, 1)), ""); assert(actual().revision == 1);
  sync(http(settings(1, 1))); reported(1); assert(fake::storageWrites == writes);
  // Neither an HTTP failure nor an offline/busy guard changes the local mapping.
  const auto before = requests.size();
  sync(http("{}", 503), "", false);
  assert(requests.size() == before + 1 && actual().revision == 1);
  pusher_sync_step(false); voiceBusy = true; fake::now += 60001; pusher_sync_step(true); voiceBusy = false;
  assert(requests.size() == before + 1);
  // A call can acquire ownership after the network precheck. Actual apply must
  // still defer the new mapping and report the existing one, not the desired one.
  acquireCallDuringGet = true;
  sync(http(settings(2, 2))); reported(1, "\"busy\"");
  assert(command("@get", "\"pusher_pending\":true"));
  servo_call_cancel(); servo_call_close(); assert(!servo_call_open());
  sync(http(settings(2, 2))); reported(2);
  assert(actual().call_start == 2 && command("@get", "\"pusher_pending\":false"));
  // Bad/stale remote state cannot silently replace the active mapping.
  sync(http("{\"paired\":true,\"pusher_settings\":[]}")); reported(2, "\"invalid_settings_response\"");
  assert(!servo_call_open());
  sync(http(settings(1, 1))); reported(2, "\"stale_revision\"");
  assert(!servo_call_open());
  sync(http("{\"paired\":true,\"pusher_settings\":null}")); reported(2);
  assert(servo_call_open()); servo_call_cancel(); servo_call_close();
  sync(http("{\"paired\":true,\"mode\":\"normal\"}")); reported(2);
  // The durable runtime interlock is reported separately from configuration ACK.
  assert(servo_test('e')); tick(100); tick(100); assert(servo_recovery_required());
  sync(http(settings(2, 2))); reported(2);
  assert(body(report()).find("\"runtime_status\":\"manual_check_required\"") != std::string::npos);
  assert(command("@confirm"));
  // A lost report and a board restart retain the committed mapping.
  const auto count = fake::servoPins.size(); servo_begin();
  sync(http(settings(2, 2))); reported(2);
  assert(fake::servoPins.size() == count && !servo_recovery_required());
  // Losing both saved slots makes the actual configuration unknowable. Still
  // report the fault/capabilities, without claiming any applied revision/config.
  fake::preferenceRecords["monban-servo/pusher-a"] = {1, 2, 3, 4};
  fake::preferenceRecords["monban-servo/pusher-b"] = {5, 6, 7, 8};
  servo_begin();
  servo_pusher_config_t unknown{};
  assert(!servo_pusher_get(&unknown) && servo_recovery_required() && !servo_call_open());
  sync(http(settings(2, 2)));
  const auto fault = body(report());
  assert(fault.find("\"applied_revision\":null") != std::string::npos);
  assert(fault.find("\"applied_config\":null") != std::string::npos);
  assert(fault.find("\"apply_error\":\"storage_failed\"") != std::string::npos);
  assert(fault.find("\"runtime_status\":\"manual_check_required\"") != std::string::npos);
  assert(fault.find("\"id\":\"p1\",\"gpio\":7") != std::string::npos);
  assert(fake::servoPins.size() == count);
  puts("pusher sync: real apply/journal/readback/report, ACK loss, busy race, invalid/stale settings, unknown-storage fault and credential isolation passed");
}
