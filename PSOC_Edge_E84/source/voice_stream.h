#pragma once
#include <stdbool.h>
void voice_stream_task(void *argument);
bool voice_stream_busy(void);
void voice_stream_request_call(void);
void voice_stream_request_stop(void);
