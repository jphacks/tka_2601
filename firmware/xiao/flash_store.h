#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include "audio_store.h"

/* The dedicated 2 MiB "audio_store" partition. */
bool flash_store_driver(audio_flash_t *driver);
#ifdef __cplusplus
}
#endif
