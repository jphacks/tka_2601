#include "wifi_reconnect.h"
#include <assert.h>
#include <stdint.h>

int main(void)
{
    const uint32_t delay = 60000;
    wifi_reconnect_t state = {0};

    /* A short hotspot outage is left to WCM. A generic deauthentication that
     * WCM does not retry eventually requests one application connection. */
    assert(!wifi_reconnect_due(&state, true, 0, delay));
    assert(!wifi_reconnect_due(&state, false, 1000, delay));
    assert(!wifi_reconnect_due(&state, false, 60999, delay));
    assert(wifi_reconnect_due(&state, false, 61000, delay));
    assert(!wifi_reconnect_due(&state, false, 121000, delay));

    /* Count the interval from completion, not from the beginning of a slow
     * failed association. An absent hotspot therefore cannot cause a spin. */
    wifi_reconnect_attempt_finished(&state, 200000);
    assert(!wifi_reconnect_due(&state, false, 200001, delay));
    assert(!wifi_reconnect_due(&state, false, 259999, delay));
    assert(wifi_reconnect_due(&state, false, 260000, delay));
    wifi_reconnect_attempt_finished(&state, 270000);

    /* A connection return cancels the old outage; a subsequent outage gets
     * a fresh grace period even after being connected for a long time. */
    assert(!wifi_reconnect_due(&state, true, 271000, delay));
    assert(!wifi_reconnect_due(&state, true, 900000, delay));
    assert(!wifi_reconnect_due(&state, false, 901000, delay));
    assert(!wifi_reconnect_due(&state, false, 960999, delay));
    assert(wifi_reconnect_due(&state, false, 961000, delay));

    /* FreeRTOS's wrapping 32-bit tick count must not delay recovery for an
     * entire clock cycle when an outage spans the wrap. */
    state = (wifi_reconnect_t){0};
    uint32_t start = UINT32_MAX - 30000;
    assert(!wifi_reconnect_due(&state, false, start, delay));
    assert(!wifi_reconnect_due(&state, false, start + delay - 1, delay));
    assert(wifi_reconnect_due(&state, false, start + delay, delay));
    wifi_reconnect_attempt_finished(&state, UINT32_MAX - 1000);
    assert(!wifi_reconnect_due(&state, false, 58998, delay));
    assert(wifi_reconnect_due(&state, false, 58999, delay));
    return 0;
}
