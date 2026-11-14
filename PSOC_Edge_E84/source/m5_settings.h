#pragma once

/* Always included so configure_m5.py can invalidate a build made before the
 * optional private header existed. */
#if __has_include("m5_config.h")
#include "m5_config.h"
#else
#include "m5_config.example.h"
#endif
