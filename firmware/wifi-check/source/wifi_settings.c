#include "wifi_settings.h"
#include "wifi_config.h"
#include "cy_wcm.h"

_Static_assert(sizeof(WIFI_SSID) <= CY_WCM_MAX_SSID_LEN + 1,
               "SSID exceeds 32 bytes");
_Static_assert(sizeof(WIFI_PASSWORD) <= CY_WCM_MAX_PASSPHRASE_LEN + 1,
               "Wi-Fi password exceeds 63 bytes");

const char wifi_ssid[] = WIFI_SSID;
const char wifi_password[] = WIFI_PASSWORD;
