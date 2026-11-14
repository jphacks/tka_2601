#pragma once
#include "audio_store.h"
/* Caller owns store exclusively. Only true means server durably acknowledged this ID. */
bool audio_upload(audio_store_t *store, unsigned slot);
bool audio_upload_configured(void);
