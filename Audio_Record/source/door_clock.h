#pragma once
#include <stdbool.h>

/* Requires Wi-Fi + DHCP and cy_socket_init(); leaves TLS disabled on failure. */
bool door_clock_sync(void);
