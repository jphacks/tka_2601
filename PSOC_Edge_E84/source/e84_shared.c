#include "cybsp.h"
#include "cycfg_memory.h"
#include "e84_shared.h"

/* The linker reserves this region on CM55 and allocates it on CM33. */
#if defined(E84_NETWORK_CORE)
__attribute__((section(".cy_shared_socmem"), aligned(32), used))
static e84_shared_t mailbox;
#endif

volatile e84_shared_t *e84_shared(void)
{
    return (volatile e84_shared_t *)(uintptr_t)CYMEM_m33_m55_shared_START;
}

void e84_shared_acquire(void) { __DMB(); }
void e84_shared_release(void) { __DMB(); }
