#include "wifi_settings.h"
#if __has_include("wifi_config.h")
#include "wifi_config.h"
#else
#include "wifi_config.example.h"
#endif
#include "cy_wcm.h"

/* Existing private headers remain valid and keep automatic security selection. */
#ifndef WIFI_HOTSPOT_COMPATIBILITY
#define WIFI_HOTSPOT_COMPATIBILITY 0
#endif
_Static_assert(WIFI_HOTSPOT_COMPATIBILITY == 0 || WIFI_HOTSPOT_COMPATIBILITY == 1,
               "WIFI_HOTSPOT_COMPATIBILITY must be 0 or 1");

_Static_assert(sizeof(WIFI_SSID) <= CY_WCM_MAX_SSID_LEN + 1,
               "SSID exceeds 32 bytes");
_Static_assert(sizeof(WIFI_PASSWORD) <= CY_WCM_MAX_PASSPHRASE_LEN + 1,
               "Wi-Fi password exceeds 63 bytes");

const char wifi_ssid[] = WIFI_SSID;
const char wifi_password[] = WIFI_PASSWORD;
const bool wifi_hotspot_compatibility = WIFI_HOTSPOT_COMPATIBILITY != 0;
const cy_wcm_security_t wifi_security = WIFI_HOTSPOT_COMPATIBILITY
    ? CY_WCM_SECURITY_WPA2_AES_PSK : CY_WCM_SECURITY_UNKNOWN;
