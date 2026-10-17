#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiUdp.h>

#include "link_protocol.h"
#include "stream_receiver.h"
#if __has_include("link_config.h")
#include "link_config.h"
#else
#include "link_config.example.h"
#endif

namespace {
WiFiUDP receiver;
e84link::ReplayCache replayCache;
bool configured = false;
bool udpReady = false;
bool previouslyConnected = false;
IPAddress boundIp;
IPAddress lastPeer;
uint16_t lastPeerPort = 0;
uint32_t pingCount = 0;
uint32_t chimeCount = 0;
uint32_t duplicateCount = 0;
uint32_t rejectedCount = 0;
uint32_t lastConnectAttempt = 0;
uint32_t lastBindAttempt = 0;
uint32_t lastPaint = 0;
const char* lastStreamStatus = nullptr;
bool paintNeeded = true;
const char* lastEvent = "Waiting for E84";

bool elapsed(uint32_t now, uint32_t then, uint32_t period) {
  return static_cast<uint32_t>(now - then) >= period;
}

void showStatus() {
  const bool connected = WiFi.status() == WL_CONNECTED;
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(8, 8);
  M5.Display.println("E84 / M5Stack Basic");
  M5.Display.setCursor(8, 38);
  if (!configured) {
    M5.Display.println("Configuration needed");
    M5.Display.setTextSize(1);
    M5.Display.println("Run configure_m5.py --prepare-receiver");
    return;
  }
  M5.Display.printf("Wi-Fi: %s\n", connected ? "Connected" : "Connecting");
  M5.Display.printf("IP: %s\n", connected ? WiFi.localIP().toString().c_str() : "-");
  M5.Display.printf("UDP: %u %s\n", static_cast<unsigned>(M5_LINK_PORT),
                    udpReady ? "Ready" : "Waiting");
  M5.Display.printf("Ping: %lu  Chime: %lu\n", static_cast<unsigned long>(pingCount),
                    static_cast<unsigned long>(chimeCount));
  M5.Display.setTextSize(1);
  M5.Display.printf("TCP: %u %s\n", static_cast<unsigned>(M5_LINK_PORT + 1),
                    e84stream::receiverReady() ? "Ready" : "Waiting");
  M5.Display.printf("Peer: %s:%u\n", lastPeer.toString().c_str(), lastPeerPort);
  M5.Display.printf("Duplicate: %lu  Rejected: %lu\n",
                    static_cast<unsigned long>(duplicateCount),
                    static_cast<unsigned long>(rejectedCount));
  M5.Display.setCursor(8, 182);
  M5.Display.println(lastEvent);
  M5.Display.setCursor(8, 196);
  M5.Display.println(e84stream::receiverStatus());
  M5.Display.setCursor(8, 220);
  M5.Display.println("A / serial s: status");
}

void logStatus() {
  Serial.printf("[STATUS] Wi-Fi=%s IP=%s UDP=%u/%s ping=%lu chime=%lu duplicate=%lu rejected=%lu\n",
                WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
                WiFi.localIP().toString().c_str(), static_cast<unsigned>(M5_LINK_PORT),
                udpReady ? "ready" : "waiting", static_cast<unsigned long>(pingCount),
                static_cast<unsigned long>(chimeCount), static_cast<unsigned long>(duplicateCount),
                static_cast<unsigned long>(rejectedCount));
  paintNeeded = true;
  e84stream::logReceiverStatus();
}

void maintainConnection(uint32_t now) {
  const IPAddress address = WiFi.localIP();
  const bool connected = WiFi.status() == WL_CONNECTED &&
                         static_cast<uint32_t>(address) != 0;
  if (!connected) {
    if (udpReady) receiver.stop();
    if (previouslyConnected) {
      Serial.println("[Wi-Fi] Disconnected; reconnecting automatically.");
      lastEvent = "Wi-Fi disconnected";
      paintNeeded = true;
    }
    udpReady = false;
    previouslyConnected = false;
    if (elapsed(now, lastConnectAttempt, 15000)) {
      lastConnectAttempt = now;
      WiFi.reconnect();
      Serial.println("[Wi-Fi] Connection retry.");
    }
    return;
  }
  if (!previouslyConnected || address != boundIp) {
    receiver.stop();
    udpReady = false;
    boundIp = address;
    lastBindAttempt = now - 2000;
    Serial.printf("[Wi-Fi] Connected. IP: %s\n", address.toString().c_str());
    lastEvent = "Waiting for E84";
    paintNeeded = true;
  }
  previouslyConnected = true;
  if (!udpReady && elapsed(now, lastBindAttempt, 2000)) {
    lastBindAttempt = now;
    udpReady = receiver.begin(static_cast<uint16_t>(M5_LINK_PORT)) != 0;
    Serial.printf("[LINK] UDP port %u: %s\n", static_cast<unsigned>(M5_LINK_PORT),
                  udpReady ? "listening" : "bind failed; retrying");
    paintNeeded = true;
  }
}

void receivePackets() {
  // Bound network work so display/buttons/reconnect remain responsive.
  for (unsigned packet = 0; packet < 4; ++packet) {
    const int packetSize = receiver.parsePacket();
    if (packetSize <= 0) break;
    if (packetSize > static_cast<int>(e84link::kMaxPacketBytes)) {
      receiver.clear();
      ++rejectedCount;
      paintNeeded = true;
      continue;
    }
    const IPAddress peer = receiver.remoteIP();
    const uint16_t peerPort = receiver.remotePort();
    char input[e84link::kMaxPacketBytes];
    const int received = receiver.read(input, static_cast<size_t>(packetSize));
    const bool complete = received == packetSize && receiver.available() == 0;
    receiver.clear();
    e84link::Message message{};
    if (!complete || !e84link::parseMessage(input, static_cast<size_t>(received),
                                           M5_LINK_TOKEN, message)) {
      ++rejectedCount;
      paintNeeded = true;
      continue;
    }
    lastPeer = peer;
    lastPeerPort = peerPort;
    const bool unique = replayCache.markUnique(message, millis());
    if (!unique) ++duplicateCount;
    if (message.kind == e84link::Kind::Ping) {
      if (unique) ++pingCount;
      // Always reply to authenticated retries; a previous pong may have been lost.
      char pong[192];
      const size_t length = e84link::formatPong(pong, sizeof(pong), message.eventId,
                                               M5_LINK_TOKEN);
      const bool sent = length != 0 && receiver.beginPacket(peer, peerPort) &&
          receiver.write(reinterpret_cast<const uint8_t*>(pong), length) == length &&
          receiver.endPacket();
      Serial.printf("[LINK] Ping received; %s. peer=%s:%u%s\n",
                    sent ? "pong sent" : "pong send failed", peer.toString().c_str(),
                    peerPort, unique ? "" : " (retry)");
      lastEvent = sent ? "Ping received / Pong sent" : "Pong send failed";
    } else if (unique) {
      ++chimeCount;
      Serial.printf("[LINK] Chime received. score=%.5f peer=%s:%u\n",
                    message.score, peer.toString().c_str(), peerPort);
      lastEvent = "Chime received";
    }
    paintNeeded = true;
  }
}
}  // namespace

void setup() {
  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  cfg.fallback_board = m5::board_t::board_M5Stack;
  cfg.internal_spk = true;
  cfg.internal_mic = false;
  M5.begin(cfg);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(255);
  Serial.println("[BOOT] M5Stack Basic / E84 Wi-Fi link");
  configured = strlen(M5_LINK_WIFI_SSID) > 0 && strlen(M5_LINK_WIFI_SSID) <= 32 &&
               strlen(M5_LINK_WIFI_PASSWORD) >= 8 && strlen(M5_LINK_WIFI_PASSWORD) <= 63 &&
               M5_LINK_PORT >= 1024 && M5_LINK_PORT <= 65534 &&
               e84link::validToken(M5_LINK_TOKEN);
  if (!configured) {
    Serial.println("[CONFIG] Missing/invalid settings. Run E84 configure_m5.py --prepare-receiver, then upload again.");
    showStatus();
    return;
  }
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(M5_LINK_WIFI_SSID, M5_LINK_WIFI_PASSWORD);
  e84stream::beginReceiver(static_cast<uint16_t>(M5_LINK_PORT + 1), M5_LINK_TOKEN);
  lastConnectAttempt = millis();
  Serial.println("[Wi-Fi] Connecting to configured 2.4 GHz network...");
  Serial.println("[HELP] s / h or button A: status");
  showStatus();
}

void loop() {
  M5.update();
  if (configured) {
    maintainConnection(millis());
    if (udpReady) receivePackets();
    e84stream::pollReceiver(udpReady, M5.BtnA.wasPressed(), M5.BtnC.wasPressed());
    if (lastStreamStatus != e84stream::receiverStatus()) {
      lastStreamStatus = e84stream::receiverStatus();
      paintNeeded = true;
    }
  }
  if (M5.BtnA.wasPressed()) logStatus();
  for (unsigned i = 0; i < 16 && Serial.available(); ++i) {
    const int command = Serial.read();
    if (command == 's' || command == 'h') logStatus();
  }
  // SPI display traffic can couple into the Basic's analog speaker output.
  if (paintNeeded && !e84stream::speakerBusy() && elapsed(millis(), lastPaint, 250)) {
    lastPaint = millis();
    paintNeeded = false;
    showStatus();
  }
  delay(2);
}
