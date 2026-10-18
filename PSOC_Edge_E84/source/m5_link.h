#pragma once
#include <stdbool.h>
bool m5_link_destination_is_local(void);
#include <stdint.h>

bool m5_link_configured(void);
/* Call from the dedicated notification task after Wi-Fi initialization.
 * A true result means at least one datagram was submitted, never delivery or
 * actuator confirmation. */
bool m5_link_send(const uint32_t id[4], float score);

/* A diagnostic exchange with the paired M5. Call only from the dedicated
 * notification task. Polls for up to 1500 ms and yields between checks;
 * success requires an authenticated pong from the configured IP and port. */
bool m5_link_probe(const uint32_t id[4]);
