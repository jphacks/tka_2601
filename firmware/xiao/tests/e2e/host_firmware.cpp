// Runs the firmware's real call, relay, WebSocket, playback, audio and servo code
// on the Mac against a real server process. Only the hardware is replaced: TCP
// without TLS, a clock-driven speaker, a scripted microphone, and fake PWM/NVS.
#include "console.h"
#include "net_task.h"
#include "servo_control.h"
#include "tune.h"
#include "voice_stream.h"
#include "voice_transport.h"
#include "playback.h"
#include "net_state.h"
#include "xlog.h"
extern "C" {
#include "door_server.h"
#include "audio_app.h"
#include "audio_link.h"
#include "audio_upload.h"
#include "storage_worker.h"
}
#include <Arduino.h>
#include <arpa/inet.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <fcntl.h>
#include <mutex>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <queue>
#include <signal.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

static auto startedAt = std::chrono::steady_clock::now();
static uint32_t nowMs() {
  return 1000u + static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt).count());
}
// --- Network: same contract as net_stream.cpp, without TLS.
static uint16_t serverPort = 0;
struct net_stream { int fd; };
extern "C" {
net_stream_t* net_stream_open(const char* host, uint16_t, const char*) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(serverPort);
  address.sin_addr.s_addr = inet_addr(host);
  if (fd < 0 || connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address))) { if (fd >= 0) close(fd); return nullptr; }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
  return new net_stream{fd};
}
int net_stream_read(net_stream_t* s, void* data, size_t length) {
  const ssize_t n = recv(s->fd, data, length, 0);
  if (n > 0) return static_cast<int>(n);
  if (n == 0) return -1;
  return errno == EAGAIN || errno == EWOULDBLOCK ? 0 : -1;
}
int net_stream_write(net_stream_t* s, const void* data, size_t length) {
  const ssize_t n = send(s->fd, data, length, 0);
  if (n >= 0) return static_cast<int>(n);
  return errno == EAGAIN || errno == EWOULDBLOCK ? 0 : -1;
}
void net_stream_close(net_stream_t* s) { close(s->fd); delete s; }
void net_random(void* out, size_t length) { arc4random_buf(out, length); }
uint32_t net_now_ms(void) { return nowMs(); }
void net_sleep_ms(uint32_t ms) { usleep(ms * 1000u); }
bool net_voice_ready(void) { return true; }
// Real SHA-1 and base64: uvicorn's handshake answer is checked against these.
int mbedtls_base64_encode(unsigned char* out, size_t capacity, size_t* written, const unsigned char* in, size_t n) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t used = 0;
  for (size_t i = 0; i < n; i += 3) {
    if (used + 5 > capacity) return -1;
    const uint32_t v = in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    out[used++] = table[v >> 18 & 63]; out[used++] = table[v >> 12 & 63];
    out[used++] = i + 1 < n ? table[v >> 6 & 63] : '=';
    out[used++] = i + 2 < n ? table[v & 63] : '=';
  }
  *written = used;
  return 0;
}
int mbedtls_sha1(const unsigned char* in, size_t n, unsigned char out[20]) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  std::vector<uint8_t> m(in, in + n);
  m.push_back(0x80);
  while (m.size() % 64 != 56) m.push_back(0);
  const uint64_t bits = static_cast<uint64_t>(n) * 8;
  for (int i = 7; i >= 0; --i) m.push_back(static_cast<uint8_t>(bits >> (i * 8)));
  auto rol = [](uint32_t v, int s) { return (v << s) | (v >> (32 - s)); };
  for (size_t block = 0; block < m.size(); block += 64) {
    uint32_t w[80];
    for (int t = 0; t < 16; ++t) w[t] = m[block + t * 4] << 24 | m[block + t * 4 + 1] << 16 | m[block + t * 4 + 2] << 8 | m[block + t * 4 + 3];
    for (int t = 16; t < 80; ++t) w[t] = rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int t = 0; t < 80; ++t) {
      const uint32_t f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const uint32_t k = t < 20 ? 0x5A827999 : t < 40 ? 0x6ED9EBA1 : t < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      const uint32_t next = rol(a, 5) + f + e + k + w[t];
      e = d; d = c; c = rol(b, 30); b = a; a = next;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  for (int i = 0; i < 5; ++i) for (int j = 0; j < 4; ++j) out[i * 4 + j] = static_cast<uint8_t>(h[i] >> (24 - j * 8));
  return 0;
}
}

// --- Same reports as net_task.cpp, for the loopback "network".
static std::atomic<bool> apiProbe{false};
void net_request_api_probe(void) {
  if (voice_stream_busy()) xlog("[DIAG] api_https busy\n");
  else apiProbe = true;
}
void net_report_wifi(void) {
  xlog("[DIAG] wifi {\"connected\":true,\"ip\":\"127.0.0.1\",\"gateway\":\"127.0.0.1\",\"rssi\":-50,\"rssi_valid\":true}\n");
}
void net_report_calibration(void) {
  xlog("[CAL] {\"ok\":true,\"diagnostic\":\"wifi\",\"connected\":true,\"ip\":\"127.0.0.1\",\"gateway\":\"127.0.0.1\",\"rssi\":-50,\"wss_ready\":true}\n");
}

// --- Speaker: consumes at the real 16 kHz rate and keeps the PCM for checks.
static std::atomic<uint64_t> spokenSamples{0};
static std::atomic<unsigned> speakerStarts{0}, speakerStops{0};
static bool sinkStart() { ++speakerStarts; return true; }
static bool sinkWrite(const int16_t*, size_t samples) {
  usleep(static_cast<useconds_t>(samples * 1000000u / 16000u));
  spokenSamples += samples;
  return true;
}
static void sinkStop() { ++speakerStops; }
static const playback_sink_t sink = {sinkStart, sinkWrite, sinkStop, 130u};

// --- Microphone: chime and speech scripts, delivered every 20 ms.
static std::mutex commandLock;
static std::queue<char> commands;
static std::atomic<bool> running{true}, ringBell{false}, ringOther{false};
static std::atomic<int> ambient{0};
extern "C" bool audio_app_post_command(char command) {
  std::lock_guard<std::mutex> guard(commandLock);
  commands.push(command);
  return true;
}
static int16_t pcm[AUDIO_FRAME];
static void bellFrame(unsigned f, unsigned total, float gain) {
  const float hz = f >= total / 2 ? 880.0f : 1320.0f;
  for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = static_cast<int16_t>(gain * sinf(6.2831853f * hz * (f * AUDIO_FRAME + i) / AUDIO_RATE));
}
static void otherFrame(unsigned f, float gain) {
  for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = static_cast<int16_t>(gain * sinf(6.2831853f * 420.0f * (f * AUDIO_FRAME + i) / AUDIO_RATE));
}
static void silenceFrame() {
  const int level = ambient;
  for (unsigned i = 0; i < AUDIO_FRAME; ++i) pcm[i] = level ? static_cast<int16_t>(arc4random_uniform(2 * level) - level) : 0;
}
static void feed() {
  audio_app_service();
  audio_app_frame(pcm, false);
  audio_app_service();
}
static void drainCommands() {
  std::lock_guard<std::mutex> guard(commandLock);
  while (!commands.empty()) { audio_app_command(commands.front()); commands.pop(); }
}
static void audioTask() {
  unsigned bell = 0, other = 0, speech = 0;
  bool speaking = false;
  auto next = std::chrono::steady_clock::now();
  while (running) {
    drainCommands();
    volatile audio_link_t* s = audio_link();
    const bool listening = s->voice_call_ack && s->voice_record_enabled && s->voice_listen_ack == s->voice_listen_seq && s->voice_listen_seq;
    if (ringBell.exchange(false)) bell = 80;
    if (ringOther.exchange(false)) other = 80;
    if (!listening) { speaking = false; speech = 0; }
    else if (!speaking) { speaking = true; speech = 60; }
    if (bell) { bellFrame(80 - bell, 50, bell > 30 ? 8000.0f : 0.0f); --bell; }
    else if (other) { otherFrame(80 - other, other > 30 ? 8000.0f : 0.0f); --other; }
    else if (speech) { bellFrame(speech, 60, 5000.0f); --speech; }
    else silenceFrame();
    feed();
    next += std::chrono::milliseconds(20);
    std::this_thread::sleep_until(next);
  }
}

// --- RAM flash for the registered chime.
static uint8_t* flashMemory;
static bool flashRead(uint32_t o, void* p, size_t n) { memcpy(p, flashMemory + o, n); return true; }
static bool flashWrite(uint32_t o, const void* p, size_t n) { auto* b = static_cast<const uint8_t*>(p); for (size_t i = 0; i < n; ++i) flashMemory[o + i] &= b[i]; return true; }
static bool flashErase(uint32_t o, size_t n) { memset(flashMemory + o, 255, n); return true; }

static void quiet(unsigned frames) { silenceFrame(); for (unsigned i = 0; i < frames; ++i) feed(); }
static void enrollAtFullSpeed() {
  quiet(50);
  audio_app_command('F'); storage_worker_step();
  audio_app_command('e');
  quiet(100);  // 2 s of background
  for (unsigned f = 0; f < 50; ++f) { bellFrame(f, 50, 8000.0f); feed(); }  // one ring
  quiet(30);
  quiet(100);  // the board checks the recorded ring
  storage_worker_step();
  assert(audio_app_model_valid());
  quiet(60);
}
static bool waitFor(bool (*condition)(), uint32_t ms) {
  const uint32_t begin = nowMs();
  while (!condition()) { if (nowMs() - begin > ms) return false; usleep(5000); }
  return true;
}

// The whole firmware behind a serial port, for working on the bench page without
// a board. kill -USR1 rings the chime; kill -USR2 plays a sound that is not the chime.
static void bench() {
  ambient = 40;
  signal(SIGUSR1, [](int) { ringBell = true; });
  signal(SIGUSR2, [](int) { ringOther = true; });
  console_begin();
  xlog("[BOOT] Network task running.\n");
  xlog("[OK] Wi-Fi connected + DHCP OK. IP: 127.0.0.1\n");
  for (;;) {
    console_poll();
    if (apiProbe.exchange(false)) {
      xlog("[DIAG] api_https checking\n");
      const bool ok = door_server_check();
      xlog("[DIAG] api_https ok=%u\n", ok ? 1u : 0u);
    }
    usleep(2000);
  }
}

int main(int argc, char** argv) {
  assert(argc == 3);
  serverPort = static_cast<uint16_t>(atoi(argv[1]));
  const std::string scenario = argv[2];
  setvbuf(stdout, nullptr, _IOLBF, 0);
  servo_begin();
  tune_begin();
  for (const char* c : {"@begin", "@time d 0", "@time c 100", "@time e 100", "@time r 100", "@save"}) servo_calibration_command(c);
  auto* ring = static_cast<audio_ring_t*>(calloc(1, sizeof(audio_ring_t)));
  auto* pending = static_cast<int16_t*>(calloc(AUDIO_CLIP_SAMPLES, sizeof(int16_t)));
  flashMemory = static_cast<uint8_t*>(malloc(AUDIO_STORE_BYTES));
  memset(flashMemory, 255, AUDIO_STORE_BYTES);
  audio_app_init(ring, pending, false);
  storage_worker_begin(audio_flash_t{flashRead, flashWrite, flashErase}, true);
  playback_init(&sink);
  if (scenario != "bench") enrollAtFullSpeed();

  std::thread speaker([] { while (running) { fake::now = nowMs(); if (!playback_step(nowMs())) usleep(2000); } });
  std::thread servo([] { while (running) { fake::now = nowMs(); servo_poll(); usleep(2000); } });
  std::thread audio(audioTask);
  std::thread storage([] { while (running) { storage_worker_step(); usleep(100000); } });
  std::thread call([] { voice_stream_task(nullptr); });
  usleep(300000);
  if (scenario == "bench") bench();

  static auto busy = [] { return voice_stream_busy(); };
  static auto idle = [] { return !voice_stream_busy(); };
  int exitCode = 0;
  if (scenario == "chime") ringBell = true;
  else voice_stream_request_call();
  if (!waitFor(+busy, 8000)) { xlog("[E2E] call never started\n"); exitCode = 2; }
  else {
    if (scenario == "stop") {
      // Stop while the greeting is still playing.
      static auto speaking = [] { return spokenSamples.load() > 8000u; };
      if (!waitFor(+speaking, 20000)) { xlog("[E2E] greeting never played\n"); exitCode = 2; }
      voice_stream_request_stop();
    }
    if (!waitFor(+idle, 60000)) { xlog("[E2E] call never finished\n"); exitCode = 3; }
  }
  usleep(200000);
  int pressesCall = 0, pressesEnd = 0;
  for (int pin : fake::servoPins) { pressesCall += pin == 7; pressesEnd += pin == 8; }
  xlog("[E2E] call_presses=%d end_presses=%d spoken_samples=%llu speaker_starts=%u speaker_stops=%u detected=%lu\n",
    pressesCall, pressesEnd, static_cast<unsigned long long>(spokenSamples.load()),
    speakerStarts.load(), speakerStops.load(), static_cast<unsigned long>(audio_link()->detected_count));
  fflush(stdout);
  // Tasks run forever on the device; leave without joining them.
  _exit(exitCode);
}
