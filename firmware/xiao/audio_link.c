#include "audio_link.h"
#include <stdatomic.h>

static audio_link_t link_storage;
volatile audio_link_t *audio_link(void) { return &link_storage; }
void audio_link_acquire(void) { atomic_thread_fence(memory_order_acquire); }
void audio_link_release(void) { atomic_thread_fence(memory_order_release); }
