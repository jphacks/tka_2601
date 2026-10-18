#pragma once
/* Optional LAN notification. Blank destination/token disables all M5 traffic.
 * Run python3 configure_m5.py --host 192.168.1.50 to make m5_config.h.
 * Only a private IPv4 on the connected LAN is accepted. No DNS/broadcast.
 * configure_m5.py --prepare-receiver pairs the M5Stack Basic receiver first.
 * Use the same secret on both boards; never log the token. */
#define M5_IPV4 ""
#define M5_PORT 8768u
#define M5_TOKEN ""
