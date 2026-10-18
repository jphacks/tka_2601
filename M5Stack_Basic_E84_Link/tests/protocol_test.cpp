#include "link_protocol.h"
extern "C" {
#include "m5_protocol.h"
}

#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <string>

namespace {
const char kToken[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const char kId[] = "000000010000000200000003ffffffff";
unsigned checks = 0;

void check(bool condition) {
  ++checks;
  assert(condition);
}

std::string ping() {
  return std::string("{\"v\":1,\"type\":\"ping\",\"event_id\":\"") + kId +
         "\",\"token\":\"" + kToken + "\"}";
}

std::string chime(const char* score = "0.18000") {
  return std::string("{\"v\":1,\"type\":\"chime\",\"event_id\":\"") + kId +
         "\",\"score\":" + score + ",\"token\":\"" + kToken + "\"}";
}

std::string replace(std::string text, const char* from, const char* to) {
  const size_t offset = text.find(from);
  assert(offset != std::string::npos);
  text.replace(offset, strlen(from), to);
  return text;
}

bool accepts(const std::string& text, e84link::Message* output = nullptr) {
  e84link::Message message{};
  const bool success = e84link::parseMessage(text.data(), text.size(), kToken, message);
  if (success && output) *output = message;
  return success;
}

void malformedPackets() {
  check(accepts(ping()));
  check(accepts(chime()));
  check(accepts(chime("-1.00000")));
  check(accepts(chime("1.8e-1")));
  check(accepts(" \n" + ping() + "\t\r"));
  check(accepts(std::string("{ \"token\":\"") + kToken +
                "\", \"event_id\":\"" + kId + "\", \"type\":\"ping\", \"v\":1 }"));
  const std::string invalid[] = {
    "", "{}", "[]", "null", ping() + "garbage", ping() + ping(),
    replace(ping(), "\"v\":1", "\"v\":2"),
    replace(ping(), "\"v\":1", "\"v\":1.0"),
    replace(ping(), "\"v\":1", "\"v\":1e0"),
    replace(ping(), "\"v\":1", "\"v\":01"),
    replace(ping(), "\"v\":1", "\"v\":true"),
    replace(ping(), "\"v\":1,", ""),
    replace(ping(), "\"v\":1", "\"v\":1,\"v\":1"),
    replace(ping(), "\"v\":1", "\"v\":1,\"extra\":0"),
    replace(ping(), "\"v\":1", "\"v\":1,\"score\":0.18"),
    replace(ping(), "ping", "pong"),
    replace(ping(), "ping", "chime"),
    replace(ping(), kId, ""),
    replace(ping(), kId, "000000010000000200000003FFFFFFff"),
    replace(ping(), kId, "000000010000000200000003ffffffff0"),
    replace(ping(), kId, "000000010000000200000003fffffff"),
    replace(ping(), kToken, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdee"),
    replace(ping(), kToken, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEf"),
    replace(ping(), kToken, ""),
    replace(ping(), "ping", "pi\\ng"),
    replace(ping(), "ping", "pi\nng"),
    replace(ping(), "}", ",}"),
    chime("-0.1"), chime("-2"), chime("NaN"), chime("Infinity"),
    chime("1e999"), chime("01"), chime(".1"), chime("1."),
    chime("1e"), chime("+1"), chime("null"), chime("[]"),
    chime("\"0.18\""), std::string(513, ' '),
  };
  for (const auto& packet : invalid) check(!accepts(packet));
  const auto valid = ping();
  for (size_t length = 0; length < valid.size(); ++length)
    check(!accepts(valid.substr(0, length)));
  auto embeddedNul = valid;
  embeddedNul.insert(1, 1, '\0');
  check(!accepts(embeddedNul));
  std::string padded(512 - valid.size(), ' ');
  check(accepts(valid + padded));
  check(!accepts(valid + padded + " "));
  e84link::Message output{};
  output.score = 123;
  check(!e84link::parseMessage(nullptr, 1, kToken, output));
  check(!e84link::parseMessage(valid.data(), valid.size(), "", output));
  check(output.score == 123);
}

void replayHandling() {
  e84link::Message message{};
  check(accepts(chime(), &message));
  e84link::ReplayCache cache;
  check(cache.markUnique(message, 100));
  check(!cache.markUnique(message, 100));
  check(!cache.markUnique(message, 100 + e84link::kReplayTtlMs - 1));
  check(cache.markUnique(message, 100 + e84link::kReplayTtlMs));
  check(!cache.markUnique(message, 101 + e84link::kReplayTtlMs));
  message.kind = e84link::Kind::Ping;
  check(cache.markUnique(message, 101 + e84link::kReplayTtlMs));
  check(!cache.markUnique(message, 102 + e84link::kReplayTtlMs));
  e84link::ReplayCache wrap;
  const uint32_t start = UINT32_MAX - 100;
  check(wrap.markUnique(message, start));
  check(!wrap.markUnique(message, 99));
  check(!wrap.markUnique(message, start + e84link::kReplayTtlMs - 1));
  check(wrap.markUnique(message, start + e84link::kReplayTtlMs));
  e84link::ReplayCache full;
  for (size_t i = 0; i < e84link::kReplayCapacity + 1; ++i) {
    snprintf(message.eventId, sizeof(message.eventId), "%032lx", static_cast<unsigned long>(i));
    check(full.markUnique(message, static_cast<uint32_t>(i)));
  }
  snprintf(message.eventId, sizeof(message.eventId), "%032x", 0);
  check(full.markUnique(message, 100));  // oldest entry was evicted
  snprintf(message.eventId, sizeof(message.eventId), "%032x", 2);
  check(!full.markUnique(message, 101));  // recent entry remains protected
}

void e84Interoperability() {
  const uint32_t words[] = {1, 2, 3, 0xffffffff};
  char packet[512];
  size_t length = m5_message_format(packet, sizeof(packet), words, 0.18f, kToken);
  e84link::Message message{};
  check(length > 0);
  check(e84link::parseMessage(packet, length, kToken, message));
  check(message.kind == e84link::Kind::Chime && !strcmp(message.eventId, kId));
  length = m5_probe_format(packet, sizeof(packet), words, kToken, false);
  check(length > 0);
  check(e84link::parseMessage(packet, length, kToken, message));
  check(message.kind == e84link::Kind::Ping && !strcmp(message.eventId, kId));
  char pong[192];
  size_t pongLength = e84link::formatPong(pong, sizeof(pong), message.eventId, kToken);
  check(pongLength > 0);
  check(m5_probe_reply_matches(pong, pongLength, words, kToken));
  length = m5_probe_format(packet, sizeof(packet), words, kToken, true);
  check(length == pongLength && !memcmp(packet, pong, length));
  check(!e84link::parseMessage(pong, pongLength, kToken, message));
  check(!e84link::formatPong(pong, 1, kId, kToken) && pong[0] == '\0');
  check(!e84link::formatPong(pong, sizeof(pong), "short", kToken));
  check(!e84link::formatPong(pong, sizeof(pong), kId, "wrong"));
  check(!e84link::formatPong(nullptr, 20, kId, kToken));
  // Repeated pings remain replyable even when the count is suppressed.
  check(accepts(ping(), &message));
  e84link::ReplayCache cache;
  for (unsigned i = 0; i < 3; ++i) {
    check(cache.markUnique(message, i * 500) == (i == 0));
    pongLength = e84link::formatPong(pong, sizeof(pong), message.eventId, kToken);
    check(m5_probe_reply_matches(pong, pongLength, words, kToken));
  }
}
}  // namespace

int main() {
  malformedPackets();
  replayHandling();
  e84Interoperability();
  printf("M5/E84 protocol: %u checks passed\n", checks);
}
