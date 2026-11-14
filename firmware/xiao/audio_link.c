#include "audio_link.h"
#include "xlog.h"
#include <stdatomic.h>
#if defined(ARDUINO_ARCH_ESP32) || defined(ESP_PLATFORM)
#include <esp_heap_caps.h>
static audio_link_t *link_storage;
bool audio_link_init(void)
{
    /* Neither this PCM queue nor its mailbox is an I2S DMA/ISR buffer. */
    if (!link_storage)
        link_storage = heap_caps_calloc(1, sizeof(*link_storage), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (link_storage)
        xlog("[MEMORY] PSRAM microphone queue: frames=%u capacity_ms=%lu bytes=%lu external_free=%lu.\n",
            (unsigned)AUDIO_LINK_RING_FRAMES,(unsigned long)(AUDIO_LINK_RING_FRAMES*20u),
            (unsigned long)sizeof(*link_storage),
            (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    return link_storage != NULL;
}
volatile audio_link_t *audio_link(void) { return link_storage; }
#else

static audio_link_t link_storage;
bool audio_link_init(void) { return true; }
volatile audio_link_t *audio_link(void) { return &link_storage; }
#endif
void audio_link_acquire(void) { atomic_thread_fence(memory_order_acquire); }
void audio_link_release(void) { atomic_thread_fence(memory_order_release); }
