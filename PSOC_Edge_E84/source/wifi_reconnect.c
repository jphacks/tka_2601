#include "wifi_reconnect.h"

bool wifi_reconnect_due(wifi_reconnect_t *state, bool link_connected,
                        uint32_t now, uint32_t interval)
{
    if (link_connected) {
        state->waiting = false;
        state->attempting = false;
        return false;
    }
    if (!state->waiting) {
        state->since = now;
        state->waiting = true;
        return false;
    }
    if (state->attempting || (uint32_t)(now - state->since) < interval) {
        return false;
    }
    state->attempting = true;
    return true;
}

void wifi_reconnect_attempt_finished(wifi_reconnect_t *state, uint32_t now)
{
    /* Start the next grace period after a potentially slow association attempt,
     * so failures never turn into a tight retry loop. */
    state->since = now;
    state->waiting = true;
    state->attempting = false;
}
