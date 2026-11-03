#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_store.h"

/* Opens the store and loads the registered model; call before the audio task. */
void storage_worker_begin(audio_flash_t flash, bool flash_available);
/* One pass of flash jobs and uploads. Storage task only. */
void storage_worker_step(void);
#ifdef __cplusplus
}
#endif
