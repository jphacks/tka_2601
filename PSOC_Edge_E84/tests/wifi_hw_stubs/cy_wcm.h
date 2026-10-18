#pragma once
#include "cybsp.h"
#define CY_WCM_INTERFACE_TYPE_STA 3u
#define CY_RSLT_WCM_BSP_INIT_ERROR 0x800001u
typedef struct {
    unsigned interface;
    mtb_hal_gpio_t wifi_wl_pin, wifi_host_wake_pin;
    void *wifi_interface_instance;
} cy_wcm_config_t;
cy_rslt_t cy_wcm_init(cy_wcm_config_t *);
