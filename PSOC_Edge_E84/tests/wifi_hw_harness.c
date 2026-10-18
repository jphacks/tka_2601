#include "e84_wifi_hw.h"
#include "cybsp.h"
#include "cy_wcm.h"
#include <assert.h>
#include <stdlib.h>

/* Test the production initializer against the API preconditions whose absence
 * caused the on-device NULL GPIO port fault, including retained IRQ objects. */
int mock_sdhc;
static int host_config;
const mtb_hal_sdio_configurator_t CYBSP_WIFI_SDIO_sdio_hal_config = {
    .host_config = &host_config
};
static unsigned fail_step, step, enabled_irqs, wcm_calls, delivered_irqs;
static mtb_hal_sdio_t *saved_sdio;
static mtb_hal_gpio_t *saved_wake;
static cy_wcm_config_t *saved_config;
static cy_stc_syspm_callback_t *saved_sleep;
static void (*handlers[2])(void);

static cy_rslt_t stage(void) { return ++step == fail_step ? 100u + step : 0u; }

cy_rslt_t mtb_hal_sdio_setup(mtb_hal_sdio_t *obj,
    const mtb_hal_sdio_configurator_t *cfg, const void *clock,
    cy_stc_sd_host_context_t *ctx)
{
    assert(cfg == &CYBSP_WIFI_SDIO_sdio_hal_config && clock == NULL && ctx);
    saved_sdio = obj;
    obj->base = CYBSP_WIFI_SDIO_HW;
    obj->context = ctx;
    return stage();
}
void Cy_SD_Host_Enable(void *base)
{
    assert(step == 1 && base == saved_sdio->base);
}
cy_rslt_t Cy_SD_Host_Init(void *base, const void *cfg, cy_stc_sd_host_context_t *ctx)
{
    assert(base == saved_sdio->base && cfg == &host_config && ctx == saved_sdio->context);
    ctx->initialized = true;
    return stage();
}
cy_rslt_t Cy_SD_Host_SetHostBusWidth(void *base, unsigned width)
{
    assert(base == saved_sdio->base && width == 4u);
    return stage();
}
cy_rslt_t mtb_hal_sdio_configure(mtb_hal_sdio_t *obj, const mtb_hal_sdio_cfg_t *cfg)
{
    assert(obj == saved_sdio && cfg->frequencyhal_hz == 25000000u && cfg->block_size == 64u);
    return stage();
}
void mtb_hal_gpio_setup(mtb_hal_gpio_t *obj, uint8_t port, uint8_t pin)
{
    assert(step == 4 && port == 11 && (pin == 1 || pin == 2));
    obj->port_addr = &mock_sdhc; /* Non-NULL, as required by the real GPIO write. */
    obj->port_num = port;
    obj->pin_num = pin;
    if (pin == CYBSP_WIFI_HOST_WAKE_PIN) saved_wake = obj;
}
cy_rslt_t Cy_SysInt_Init(const cy_stc_sysint_t *cfg, void (*handler)(void))
{
    assert(cfg->intrSrc < 2 && cfg->intrPriority == (cfg->intrSrc == 0 ? 7u : 2u));
    handlers[cfg->intrSrc] = handler;
    return stage();
}
void mtb_hal_sdio_process_interrupt(mtb_hal_sdio_t *obj)
{
    assert(obj == saved_sdio && obj->base == CYBSP_WIFI_SDIO_HW);
    assert(obj->context && obj->context->initialized);
    ++delivered_irqs;
}
void mtb_hal_gpio_process_interrupt(mtb_hal_gpio_t *obj)
{
    assert(obj == saved_wake && obj->port_addr && obj->port_num == 11 && obj->pin_num == 2);
    ++delivered_irqs;
}
void NVIC_EnableIRQ(unsigned irq)
{
    assert(irq < 2 && saved_sdio->context->initialized && saved_wake->port_addr);
    assert(handlers[irq]);
    enabled_irqs |= 1u << irq;
    handlers[irq](); /* An IRQ may arrive immediately after it is enabled. */
}
void Cy_SD_Host_DeepSleepCallback(void) {}
bool Cy_SysPm_RegisterCallback(cy_stc_syspm_callback_t *callback)
{
    assert(callback->callback == Cy_SD_Host_DeepSleepCallback);
    assert(callback->type == CY_SYSPM_DEEPSLEEP);
    assert(callback->callbackParams->context == saved_sdio->context);
    assert(callback->callbackParams->base == CYBSP_WIFI_SDIO_HW);
    saved_sleep = callback;
    return stage() == 0;
}
cy_rslt_t cy_wcm_init(cy_wcm_config_t *cfg)
{
    assert(enabled_irqs == 3 && delivered_irqs == 2);
    assert(cfg->interface == CY_WCM_INTERFACE_TYPE_STA);
    assert(cfg->wifi_interface_instance == saved_sdio);
    assert(cfg->wifi_wl_pin.port_addr && cfg->wifi_wl_pin.port_num == 11);
    assert(cfg->wifi_wl_pin.pin_num == CYBSP_WIFI_WL_REG_ON_PIN);
    assert(&cfg->wifi_host_wake_pin == saved_wake);
    saved_config = cfg;
    ++wcm_calls;
    return stage();
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    fail_step = (unsigned)strtoul(argv[1], NULL, 10);
    unsigned last_step = CY_CFG_PWR_SYS_IDLE_MODE == CY_CFG_PWR_MODE_DEEPSLEEP ? 8u : 7u;
    cy_rslt_t result = e84_wifi_init();
    if (fail_step) {
        assert(step == fail_step);
        assert(wcm_calls == (fail_step == last_step ? 1u : 0u));
        assert(enabled_irqs == (fail_step == last_step ? 3u : 0u));
        assert(result == (fail_step >= 5u && fail_step < last_step ?
                         CY_RSLT_WCM_BSP_INIT_ERROR : 100u + fail_step));
        return 0;
    }
    assert(result == CY_RSLT_SUCCESS && wcm_calls == 1 && step == last_step);
    /* Dereference retained objects after the production function has returned.
     * ASan's use-after-return mode catches accidental automatic lifetimes. */
    assert(saved_config->wifi_interface_instance == saved_sdio);
    handlers[0]();
    handlers[1]();
    assert(delivered_irqs == 4);
    if (last_step == 8u) {
        assert(saved_sleep->callbackParams->context == saved_sdio->context);
        saved_sleep->callback();
    }
    return 0;
}
