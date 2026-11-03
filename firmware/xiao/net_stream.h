#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* One TLS connection. Certificate chain, hostname and validity dates are all
 * checked before net_stream_open returns. Implemented in net_stream.cpp. */
typedef struct net_stream net_stream_t;
net_stream_t *net_stream_open(const char *host, uint16_t port, const char *ca_pem);
/* >0 bytes read, 0 nothing yet, <0 closed or failed. Never waits for data. */
int net_stream_read(net_stream_t *stream, void *data, size_t length);
/* >0 bytes accepted, 0 retry later, <0 failed. */
int net_stream_write(net_stream_t *stream, const void *data, size_t length);
void net_stream_close(net_stream_t *stream);
void net_random(void *out, size_t length);
uint32_t net_now_ms(void);
void net_sleep_ms(uint32_t ms);
#ifdef __cplusplus
}
#endif
