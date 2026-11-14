#pragma once
#ifdef __cplusplus
extern "C" {
#endif
/* One whole line per call; goes to the XIAO's USB serial, or stdout in host tests. */
void xlog(const char *format, ...) __attribute__((format(printf, 1, 2)));
#ifdef __cplusplus
}
#endif
