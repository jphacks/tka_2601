#pragma once
#include "cy_result.h"
#include <stdbool.h>
#include <stddef.h>

#define CY_CFG_PWR_MODE_DEEPSLEEP 1
#define CY_SD_HOST_SUCCESS 0u
#define CY_SYSINT_SUCCESS 0u
#define CY_SD_HOST_BUS_WIDTH_4_BIT 4u
#define CY_SYSPM_DEEPSLEEP 1u
#define CYBSP_WIFI_SDIO_IRQ 0u
#define CYBSP_WIFI_HOST_WAKE_IRQ 1u
#define CYBSP_WIFI_WL_REG_ON_PORT_NUM 11u
#define CYBSP_WIFI_WL_REG_ON_PIN 1u
#define CYBSP_WIFI_HOST_WAKE_PORT_NUM 11u
#define CYBSP_WIFI_HOST_WAKE_PIN 2u
extern int mock_sdhc;
#define CYBSP_WIFI_SDIO_HW (&mock_sdhc)

typedef struct { bool initialized; } cy_stc_sd_host_context_t;
typedef struct { void *base; cy_stc_sd_host_context_t *context; } mtb_hal_sdio_t;
typedef struct { void *port_addr; uint8_t port_num, pin_num; } mtb_hal_gpio_t;
typedef struct { const void *host_config; } mtb_hal_sdio_configurator_t;
typedef struct { uint32_t frequencyhal_hz, block_size; } mtb_hal_sdio_cfg_t;
typedef struct { unsigned intrSrc, intrPriority; } cy_stc_sysint_t;
typedef struct { void *context, *base; } cy_stc_syspm_callback_params_t;
typedef struct {
    void (*callback)(void);
    unsigned type;
    cy_stc_syspm_callback_params_t *callbackParams;
} cy_stc_syspm_callback_t;
extern const mtb_hal_sdio_configurator_t CYBSP_WIFI_SDIO_sdio_hal_config;

cy_rslt_t mtb_hal_sdio_setup(mtb_hal_sdio_t *, const mtb_hal_sdio_configurator_t *,
                            const void *, cy_stc_sd_host_context_t *);
void Cy_SD_Host_Enable(void *);
cy_rslt_t Cy_SD_Host_Init(void *, const void *, cy_stc_sd_host_context_t *);
cy_rslt_t Cy_SD_Host_SetHostBusWidth(void *, unsigned);
cy_rslt_t mtb_hal_sdio_configure(mtb_hal_sdio_t *, const mtb_hal_sdio_cfg_t *);
void mtb_hal_gpio_setup(mtb_hal_gpio_t *, uint8_t, uint8_t);
cy_rslt_t Cy_SysInt_Init(const cy_stc_sysint_t *, void (*)(void));
void NVIC_EnableIRQ(unsigned);
void mtb_hal_sdio_process_interrupt(mtb_hal_sdio_t *);
void mtb_hal_gpio_process_interrupt(mtb_hal_gpio_t *);
void Cy_SD_Host_DeepSleepCallback(void);
bool Cy_SysPm_RegisterCallback(cy_stc_syspm_callback_t *);
