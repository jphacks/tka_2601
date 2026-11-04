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
static void sync(const std::string& getResponse, const std::string& putResponse = http("{}"), bool report = true, uint32_t advance = 60001) {
  responses.push_back(getResponse); if (report) responses.push_back(putResponse);
  fake::now += advance; pusher_sync_step(true); assert(responses.empty());
}
static void noPoll(uint32_t advance) {
  const auto before = requests.size();
  fake::now += advance; pusher_sync_step(true);
  assert(requests.size() == before && responses.empty());
}
static void getOnly(unsigned revision, unsigned id, uint32_t advance) {
  const auto before = requests.size();
  sync(http(settings(revision, id)), "", false, advance);
  assert(requests.size() == before + 1);
}
static void cadenceAndDedup() {
  const auto writes = fake::storageWrites;
  noPoll(4999);
  getOnly(1, 1, 1); // Initial fast polling, but no repeated PUT.
  for (unsigned i = 0; i < 5; ++i) getOnly(1, 1, 5000);
  noPoll(29999); // After 30 seconds of stable content, GET slows to 30 seconds.
  const auto before = requests.size();
  sync(http(settings(1, 1)), http("{}"), true, 1);
  assert(requests.size() == before + 2); // Exactly the 60-second heartbeat PUT.
  noPoll(29999); getOnly(1, 1, 1);
  assert(fake::storageWrites == writes);
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
static void conflictSync(const std::string& fallbackResponse, bool expectFallback = true, unsigned firstStatus = 409) {
  static unsigned desiredRevision = 3;
  const auto before = requests.size(), operations = fake::servoPins.size(), writes = fake::storageWrites;
  responses.push_back(http(settings(desiredRevision++, 1)));
  responses.push_back(http("{\"error\":\"pusher_report_config_conflict\"}", firstStatus));
  if (expectFallback) responses.push_back(fallbackResponse);
  fake::now += 60001; pusher_sync_step(true);
  assert(responses.empty());
  assert(requests.size() == before + (expectFallback ? 3 : 2));
  const auto ack = body(requests[before + 1]);
  assert(ack.find("\"applied_revision\":2") != std::string::npos);
  assert(ack.find("\"runtime_status\":\"manual_check_required\"") != std::string::npos);
  if (expectFallback) {
    const auto fallback = body(report());
    assert(fallback.find("\"applied_revision\":null") != std::string::npos);
    assert(fallback.find("\"applied_config\":null") != std::string::npos);
    assert(fallback.find("\"runtime_status\":\"manual_check_required\"") != std::string::npos);
    assert(fallback.find("\"apply_error\":\"manual_check_required\"") != std::string::npos);
    assert(fallback.find("\"id\":\"p2\",\"gpio\":8") != std::string::npos);
  }
  assert(actual().revision == 2 && servo_recovery_required());
  assert(command("@get", "\"pusher_pending\":true"));
  assert(fake::servoPins.size() == operations && fake::storageWrites == writes);
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
  const auto usbWrites = fake::storageWrites;
  assert(!command("@pusher 0 3 1 2", "cloud_managed"));
  assert(!command("@pusher 2 3 1 2", "invalid_pusher_config"));
  assert(actual().revision == 1 && actual().enabled_mask == 1 && fake::storageWrites == usbWrites);
  cadenceAndDedup();
  // A dropped cloud ACK is retried from readback, without another NVS write.
  const auto writes = fake::storageWrites;
  sync(http(settings(1, 1)), ""); assert(actual().revision == 1);
  noPoll(59999); // Stable-mode HTTP failure backs off, capped at 60 seconds.
  sync(http(settings(1, 1)), http("{}"), true, 1); reported(1); assert(fake::storageWrites == writes);
  noPoll(29999); getOnly(1, 1, 1); // Only successful reports update heartbeat/cache.
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
  noPoll(4999); getOnly(2, 2, 1); // A changed desired/applied mapping restores fast GET.
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
  // The app saved rev3 before rev2's ACK reached the cloud, while the local
  // shared operation became uncertain. The rejected ACK must not hide recovery.
  conflictSync(http("{}"));
  const auto conflictWrites = fake::storageWrites;
  getOnly(3, 1, 5000); // Successful status-only fallback is deduplicated too.
  const auto beforeHeartbeat = requests.size();
  sync(http(settings(3, 1)), http("{}"), true, 55000);
  assert(requests.size() == beforeHeartbeat + 2); // Status-only heartbeat, no rejected ACK retry.
  assert(body(report()).find("\"applied_revision\":null") != std::string::npos);
  assert(command("@get", "\"pusher_pending\":true") && fake::storageWrites == conflictWrites);
  conflictSync(http("{}", 409)); // Exactly one fallback even if it also conflicts.
  conflictSync(""); // Transport/ACK loss during fallback does not loop.
  conflictSync(http("{}", 503));
  conflictSync("", false, 429); // Other statuses are not revision conflicts.
  conflictSync("", false, 503);
  assert(command("@confirm"));
  sync(http(settings(3, 1))); reported(3); // Cleared recovery/new context returns to a normal ACK.
  assert(command("@get", "\"pusher_pending\":false"));
  // A failed changed-body PUT must not enter the dedup cache. Retry it before
  // the heartbeat deadline, then deduplicate only after a successful response.
  const auto invalid = http("{\"paired\":true,\"pusher_settings\":[]}");
  auto beforeRetry = requests.size();
  sync(invalid, http("{}", 503), true, 5000);
  assert(requests.size() == beforeRetry + 2);
  noPoll(9999);
  sync(invalid, http("{}"), true, 1); reported(3, "\"invalid_settings_response\"");
  beforeRetry = requests.size();
  sync(invalid, "", false, 5000); assert(requests.size() == beforeRetry + 1);
  sync(http(settings(3, 1)), http("{}"), true, 5000); reported(3);
  // GET failures back off without any PUT; the cap is one minute, never more.
  sync(http("{}", 503), "", false, 5000);
  for (uint32_t delay : {10000u, 20000u, 40000u, 60000u}) {
    noPoll(delay - 1u);
    const auto beforeFailure = requests.size();
    sync(http("{}", 503), "", false, 1);
    assert(requests.size() == beforeFailure + 1);
  }
  noPoll(59999);
  sync(http(settings(3, 1)), http("{}"), true, 1); reported(3);
  // A lost report and a board restart retain the committed mapping.
  const auto count = fake::servoPins.size(); servo_begin();
  sync(http(settings(3, 1))); reported(3);
  assert(fake::servoPins.size() == count && !servo_recovery_required());
  // Losing both saved slots makes the actual configuration unknowable. Still
  // report the fault/capabilities, without claiming any applied revision/config.
  fake::preferenceRecords["monban-servo/pusher-a"] = {1, 2, 3, 4};
  fake::preferenceRecords["monban-servo/pusher-b"] = {5, 6, 7, 8};
  servo_begin();
  servo_pusher_config_t unknown{};
  assert(!servo_pusher_get(&unknown) && servo_recovery_required() && !servo_call_open());
  sync(http(settings(3, 1)));
  const auto fault = body(report());
  assert(fault.find("\"applied_revision\":null") != std::string::npos);
  assert(fault.find("\"applied_config\":null") != std::string::npos);
  assert(fault.find("\"apply_error\":\"storage_failed\"") != std::string::npos);
  assert(fault.find("\"runtime_status\":\"manual_check_required\"") != std::string::npos);
  assert(fault.find("\"id\":\"p1\",\"gpio\":7") != std::string::npos);
  assert(fake::servoPins.size() == count);
  puts("pusher sync: real apply/readback, dedup, heartbeat, adaptive polling/backoff, 409 recovery, cloud-only writes and storage faults passed");
}
