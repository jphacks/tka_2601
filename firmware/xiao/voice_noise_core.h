#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
void *voice_noise_core_create(void);
void voice_noise_core_destroy(void *state);
size_t voice_noise_core_bytes(void);
void voice_noise_core_clear(void *state);
void voice_noise_core_hop(void *state,const int16_t in[160],int16_t out[160]);
bool voice_noise_core_ready(const void *state);
void voice_noise_core_copy(void *destination,const void *source);
void voice_noise_core_restart(void *state);
