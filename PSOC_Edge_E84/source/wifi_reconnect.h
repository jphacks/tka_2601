#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Zero-initialize before the first use. All calls belong to the network task. */
typedef struct {
    uint32_t since;
    bool waiting;
    bool attempting;
} wifi_reconnect_t;

/* Give WCM time to recover on its own before requesting an application retry.
 * `now` and `interval` must use the same wrapping 32-bit clock (RTOS ticks are
 * suitable). Pass Wi-Fi association state, not DHCP or server availability.
 * A true result must be followed by wifi_reconnect_attempt_finished after the
 * synchronous connection attempt returns, including when it fails. */
bool wifi_reconnect_due(wifi_reconnect_t *state, bool link_connected,
                        uint32_t now, uint32_t interval);
void wifi_reconnect_attempt_finished(wifi_reconnect_t *state, uint32_t now);
