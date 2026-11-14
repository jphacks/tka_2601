#include "net_task.h"
#include "door_server.h"
#include "net_state.h"
#include "voice_stream.h"
#include "pusher_sync.h"
#include "device_mode.h"
#include "chime_enroll_sync.h"
#include "xlog.h"
#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <time.h>

#if __has_include("wifi_config.h")
#include "wifi_config.h"
#else
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#endif
#ifndef WIFI_HOTSPOT_COMPATIBILITY
#define WIFI_HOTSPOT_COMPATIBILITY 0
#endif
static_assert(sizeof(WIFI_SSID) <= 33, "SSID exceeds 32 bytes");
static_assert(sizeof(WIFI_PASSWORD) <= 64, "Wi-Fi password exceeds 63 bytes");

namespace {
volatile bool clockReady = false, apiProbeRequested = false;
constexpr time_t kEarliestValidTime = 1704067200; // 2024-01-01: anything older is an unset clock
bool configured() { return sizeof(WIFI_SSID) > 1 && sizeof(WIFI_PASSWORD) >= 9; }
bool connected() { return WiFi.status() == WL_CONNECTED && static_cast<uint32_t>(WiFi.localIP()) != 0; }
}

bool net_voice_ready(void) { return clockReady && connected(); }
void net_request_api_probe(void) {
  if (voice_stream_busy()) xlog("[DIAG] api_https busy\n");
  else if (apiProbeRequested) xlog("[DIAG] api_https already_running\n");
  else apiProbeRequested = true;
}
void net_report_wifi(void) {
  const bool link = connected();
  xlog("[DIAG] wifi {\"connected\":%s,\"ip\":\"%s\",\"gateway\":\"%s\",\"rssi\":%d,\"rssi_valid\":%s}\n",
    link ? "true" : "false", WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(),
    link ? WiFi.RSSI() : 0, link ? "true" : "false");
}
void net_report_calibration(void) {
  xlog("[CAL] {\"ok\":true,\"diagnostic\":\"wifi\",\"connected\":%s,\"ip\":\"%s\",\"gateway\":\"%s\",\"rssi\":%d,\"wss_ready\":%s}\n",
    connected() ? "true" : "false", WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(),
    connected() ? WiFi.RSSI() : 0, net_voice_ready() ? "true" : "false");
}
void net_task(void*) {
  xlog("[BOOT] Network task running.\n");
  if (!configured()) {
    xlog("[SETUP] Configure Wi-Fi with python3 configure_wifi.py and rebuild. Audio continues offline.\n");
  } else {
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    esp_wifi_set_country_code("JP", true);
    WiFi.setSleep(false); // Keep low-latency bidirectional audio on phone hotspots.
    WiFi.setAutoReconnect(true);
    if (WIFI_HOTSPOT_COMPATIBILITY) {
      WiFi.setMinSecurity(WIFI_AUTH_WPA2_PSK);
      xlog("[Wi-Fi] Hotspot mode: 2.4 GHz / WPA2. Enable Maximize Compatibility on iPhone and keep Personal Hotspot settings open.\n");
    }
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    xlog("[Wi-Fi] Connecting to configured 2.4 GHz network...\n");
  }
  bool wasConnected = false, ntpStarted = false;
  uint32_t lastAttempt = millis();
  for (;;) {
    const bool link = connected();
    if (link && !wasConnected) {
      xlog("[OK] Wi-Fi connected + DHCP OK. IP: %s\n", WiFi.localIP().toString().c_str());
      if (!ntpStarted) {
        configTzTime("JST-9", "ntp.nict.jp", "time.google.com", "pool.ntp.org");
        ntpStarted = true;
      }
    } else if (!link && wasConnected) {
      xlog("[Wi-Fi] Connection lost; reconnecting automatically. If using a phone, enable its hotspot again.\n");
    }
    wasConnected = link;
    if (configured() && !link && millis() - lastAttempt >= 15000) {
      lastAttempt = millis();
      WiFi.reconnect();
      xlog("[Wi-Fi] Connection retry.\n");
    }
    if (ntpStarted && !clockReady && time(nullptr) >= kEarliestValidTime) {
      clockReady = true;
      xlog("[TIME] Clock synchronized.\n");
    }
    if (apiProbeRequested) {
      if (voice_stream_busy()) xlog("[DIAG] api_https busy\n");
      else if (!net_voice_ready()) xlog("[DIAG] api_https network_not_ready\n");
      else {
        xlog("[DIAG] api_https checking\n");
        const bool ok = door_server_check();
        xlog("[DIAG] api_https ok=%u\n", ok ? 1u : 0u);
      }
      apiProbeRequested = false;
    }
    pusher_sync_step(net_voice_ready());
    device_mode_sync_step(net_voice_ready());
    chime_enroll_sync_step(net_voice_ready());
    delay(200);
  }
}
