#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
/* Called by the existing network task, never by the real-time audio task. */
void pusher_sync_step(bool network_ready);
#ifdef __cplusplus
}
#endif
