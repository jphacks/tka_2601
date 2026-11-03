#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>

/* Wi-Fi connected and the clock synchronized, which TLS date checks require. */
bool net_voice_ready(void);
#ifdef __cplusplus
}
#endif
