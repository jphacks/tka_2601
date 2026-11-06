#pragma once
#include "bounded_http.h"
#ifdef __cplusplus
extern "C" {
#endif
/* The authenticated Edge Function client shared by the periodic sync tasks.
 * Every request is bounded to 10 s and 8 KiB; the caller frees the response. */
bool device_http_configured(void);
response_t *device_http_request(const char *method, const char *path, const char *body, size_t bytes);
/* Next retry delay after a failure: at least 5 s, doubling, at most 60 s. */
uint32_t device_http_retry_interval(uint32_t interval);
#ifdef __cplusplus
}
#endif
