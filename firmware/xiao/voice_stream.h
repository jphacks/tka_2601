#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
void voice_stream_task(void *argument);
bool voice_stream_busy(void);
bool voice_stream_recovery_required(void);
void voice_stream_request_call(void);
void voice_stream_request_stop(void);
void voice_stream_request_api_probe(void);
void voice_stream_request_speaker_test(void);
void voice_stream_request_loopback(void);
#ifdef __cplusplus
}
#endif
