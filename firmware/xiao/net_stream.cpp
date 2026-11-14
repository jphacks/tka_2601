#include "net_stream.h"
#include "xlog.h"
#include <Arduino.h>
#include <NetworkClientSecure.h>
#include <esp_heap_caps.h>
#include <esp_random.h>
#include <mbedtls/x509_crt.h>
#include <time.h>

namespace {
constexpr int32_t kConnectTimeoutMs = 5000; // also bounds a stalled TLS write
constexpr unsigned long kHandshakeTimeoutSeconds = 15;

// Calendar days from civil date, enough for comparing validity timestamps.
int64_t toSeconds(const mbedtls_x509_time& t) {
  int y = t.year, m = t.mon, d = t.day;
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153u * static_cast<unsigned>(m + (m > 2 ? -3 : 9)) + 2u) / 5u + d - 1u;
  const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
  const int64_t days = era * 146097LL + static_cast<int64_t>(doe) - 719468LL;
  return days * 86400LL + t.hour * 3600LL + t.min * 60LL + t.sec;
}
}

struct net_stream { NetworkClientSecure client; };

extern "C" {
net_stream_t *net_stream_open(const char *host, uint16_t port, const char *ca_pem) {
  auto *stream = new (std::nothrow) net_stream;
  if (!stream) return nullptr;
  stream->client.setCACert(ca_pem);
  stream->client.setHandshakeTimeout(kHandshakeTimeoutSeconds);
  static const char *alpn[] = {"http/1.1", nullptr};
  stream->client.setAlpnProtocols(alpn);
  if (!stream->client.connect(host, port, kConnectTimeoutMs)) {
    // Tell a TLS rejection (mbedTLS code) apart from a heap too small for a TLS session.
    char reason[96] = "";
    const int code = stream->client.lastError(reason, sizeof(reason));
    xlog("[NET] TLS connect failed host=%s mbedtls=%d (%s) heap_free=%u internal_largest=%u\n", host, code,
      reason[0] ? reason : "none", static_cast<unsigned>(esp_get_free_heap_size()),
      static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    delete stream;
    return nullptr;
  }
  // This build of mbedTLS has no MBEDTLS_HAVE_TIME_DATE, so the chain check
  // ignores validity dates. Check the server certificate against the NTP clock.
  const mbedtls_x509_crt *peer = stream->client.getPeerCertificate();
  const int64_t now = static_cast<int64_t>(time(nullptr));
  if (!peer || now < toSeconds(peer->valid_from) || now > toSeconds(peer->valid_to)) {
    xlog("[SERVER] Server certificate is outside its validity period, or the clock is wrong.\n");
    stream->client.stop();
    delete stream;
    return nullptr;
  }
  return stream;
}
int net_stream_read(net_stream_t *stream, void *data, size_t length) {
  const int available = stream->client.available();
  if (available <= 0) return stream->client.connected() ? 0 : -1;
  const int got = stream->client.read(static_cast<uint8_t *>(data), length < static_cast<size_t>(available) ? length : available);
  if (got > 0) return got;
  return stream->client.connected() ? 0 : -1;
}
int net_stream_write(net_stream_t *stream, const void *data, size_t length) {
  // Blocks up to kConnectTimeoutMs; returning 0 means the client closed itself.
  const size_t sent = stream->client.write(static_cast<const uint8_t *>(data), length);
  return sent ? static_cast<int>(sent) : -1;
}
void net_stream_close(net_stream_t *stream) {
  stream->client.stop();
  delete stream;
}
void net_random(void *out, size_t length) { esp_fill_random(out, length); }
uint32_t net_now_ms(void) { return millis(); }
void net_sleep_ms(uint32_t ms) { delay(ms); }
}
