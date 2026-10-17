#pragma once

#include "cy_result.h"

/* Called once by the network task. Owns the persistent GPIO/SDIO objects that
 * WCM and its interrupt handlers use for the lifetime of the application. */
cy_rslt_t e84_wifi_init(void);
