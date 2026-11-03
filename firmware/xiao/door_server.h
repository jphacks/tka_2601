#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>

/* Call from a task after Wi-Fi and clock synchronization. */
bool door_server_check(void);
#ifdef __cplusplus
}
#endif
