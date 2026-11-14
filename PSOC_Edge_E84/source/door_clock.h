#pragma once
#include <stdbool.h>

/* CM33 only. Requires startup RTC/CLIB initialization, Wi-Fi + DHCP and
 * cy_socket_init(). Caller must not start HTTPS unless this returns true. */
bool door_clock_sync(void);
