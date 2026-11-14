#ifndef E84_AUDIO_APP_H
#define E84_AUDIO_APP_H

/* FreeRTOS CM55 task entry. Create with a 4096-word stack and priority 4.
 * BSP and the shared mailbox must already be initialized. CM55 data caching
 * must be disabled (or the mailbox mapped noncacheable) before this runs. */
void e84_audio_task(void *argument);

#endif
