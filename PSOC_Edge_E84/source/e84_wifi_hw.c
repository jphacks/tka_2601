#include "e84_wifi_hw.h"
#include "cybsp.h"
#include "cy_wcm.h"
#include <stdio.h>

/* E84 uses MTB HAL: unlike the older cyhal target, WCM does not initialize
 * GPIO/SDIO objects itself. Follow the Infineon E84 HTTPS Client setup. */
static mtb_hal_sdio_t sdio;
static cy_stc_sd_host_context_t host_context;
static cy_wcm_config_t config;

#if (CY_CFG_PWR_SYS_IDLE_MODE == CY_CFG_PWR_MODE_DEEPSLEEP)
static cy_stc_syspm_callback_params_t sleep_params = {
    .context = &host_context,
    .base = CYBSP_WIFI_SDIO_HW
};
static cy_stc_syspm_callback_t sleep_callback = {
    .callback = Cy_SD_Host_DeepSleepCallback,
    .type = CY_SYSPM_DEEPSLEEP,
    .callbackParams = &sleep_params
};
#endif

static void sdio_interrupt(void)
{
    mtb_hal_sdio_process_interrupt(&sdio);
}

static void host_wake_interrupt(void)
{
    mtb_hal_gpio_process_interrupt(&config.wifi_host_wake_pin);
}

cy_rslt_t e84_wifi_init(void)
{
    printf("[BOOT] Preparing Wi-Fi GPIO and SDIO...\n");
    cy_rslt_t result = mtb_hal_sdio_setup(&sdio,
        &CYBSP_WIFI_SDIO_sdio_hal_config, NULL, &host_context);
    if (result != CY_RSLT_SUCCESS) return result;

    Cy_SD_Host_Enable(CYBSP_WIFI_SDIO_HW);
    result = (cy_rslt_t)Cy_SD_Host_Init(CYBSP_WIFI_SDIO_HW,
        CYBSP_WIFI_SDIO_sdio_hal_config.host_config, &host_context);
    if (result != CY_SD_HOST_SUCCESS) return result;
    result = (cy_rslt_t)Cy_SD_Host_SetHostBusWidth(CYBSP_WIFI_SDIO_HW,
                                                CY_SD_HOST_BUS_WIDTH_4_BIT);
    if (result != CY_SD_HOST_SUCCESS) return result;
    const mtb_hal_sdio_cfg_t bus = {
        .frequencyhal_hz = 25000000U,
        .block_size = 64U
    };
    result = mtb_hal_sdio_configure(&sdio, &bus);
    if (result != CY_RSLT_SUCCESS) return result;

    mtb_hal_gpio_setup(&config.wifi_wl_pin,
        CYBSP_WIFI_WL_REG_ON_PORT_NUM, CYBSP_WIFI_WL_REG_ON_PIN);
    mtb_hal_gpio_setup(&config.wifi_host_wake_pin,
        CYBSP_WIFI_HOST_WAKE_PORT_NUM, CYBSP_WIFI_HOST_WAKE_PIN);
    config.interface = CY_WCM_INTERFACE_TYPE_STA;
    config.wifi_interface_instance = &sdio;

    /* With 3 priority bits, priority 2 equals FreeRTOS's 0x40 syscall ceiling.
     * Install and enable IRQs only after their HAL objects are initialized. */
    const cy_stc_sysint_t sdio_irq = {
        .intrSrc = CYBSP_WIFI_SDIO_IRQ, .intrPriority = 7U
    };
    const cy_stc_sysint_t wake_irq = {
        .intrSrc = CYBSP_WIFI_HOST_WAKE_IRQ, .intrPriority = 2U
    };
    if (Cy_SysInt_Init(&sdio_irq, sdio_interrupt) != CY_SYSINT_SUCCESS ||
        Cy_SysInt_Init(&wake_irq, host_wake_interrupt) != CY_SYSINT_SUCCESS)
        return CY_RSLT_WCM_BSP_INIT_ERROR;

#if (CY_CFG_PWR_SYS_IDLE_MODE == CY_CFG_PWR_MODE_DEEPSLEEP)
    if (!Cy_SysPm_RegisterCallback(&sleep_callback))
        return CY_RSLT_WCM_BSP_INIT_ERROR;
#endif
    NVIC_EnableIRQ(CYBSP_WIFI_SDIO_IRQ);
    NVIC_EnableIRQ(CYBSP_WIFI_HOST_WAKE_IRQ);
    printf("[BOOT] Wi-Fi GPIO/SDIO ready. Starting WCM...\n");
    return cy_wcm_init(&config);
}
