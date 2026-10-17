/*******************************************************************************
* File Name:   main.c
*
* Description: Wi-Fi connection and DHCP test, adapted from the Wi-Fi Scan example.
*
* Related Document: See README.md
*
*
*******************************************************************************
* Copyright 2020-2024, Cypress Semiconductor Corporation (an Infineon company) or
* an affiliate of Cypress Semiconductor Corporation.  All rights reserved.
*
* This software, including source code, documentation and related
* materials ("Software") is owned by Cypress Semiconductor Corporation
* or one of its affiliates ("Cypress") and is protected by and subject to
* worldwide patent protection (United States and foreign),
* United States copyright laws and international treaty provisions.
* Therefore, you may use this Software only as provided in the license
* agreement accompanying the software package from which you
* obtained this Software ("EULA").
* If no EULA applies, Cypress hereby grants you a personal, non-exclusive,
* non-transferable license to copy, modify, and compile the Software
* source code solely for use in connection with Cypress's
* integrated circuit products.  Any reproduction, modification, translation,
* compilation, or representation of this Software except as specified
* above is prohibited without the express written permission of Cypress.
*
* Disclaimer: THIS SOFTWARE IS PROVIDED AS-IS, WITH NO WARRANTY OF ANY KIND,
* EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, NONINFRINGEMENT, IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. Cypress
* reserves the right to make changes to the Software without notice. Cypress
* does not assume any liability arising out of the application or use of the
* Software or any product or circuit described in the Software. Cypress does
* not authorize its products for use in any products where a malfunction or
* failure of the Cypress product may reasonably be expected to result in
* significant property damage, injury or death ("High Risk Product"). By
* including Cypress's product in a High Risk Product, the manufacturer
* of such system or application assumes all risk of such use and in doing
* so agrees to indemnify Cypress against all liability.
*******************************************************************************/

#include "cybsp.h"
#include "cyhal.h"
#include "cy_retarget_io.h"
#include "FreeRTOS.h"
#include "task.h"
#include "cy_wcm.h"
#include "wifi_settings.h"
#include "cy_secure_sockets.h"
#include "door_clock.h"
#include "door_server.h"
#include "cy_log.h"
#include <stdio.h>
#include <string.h>

static void stop_task(const char *step, cy_rslt_t result)
{
    cyhal_gpio_write(CYBSP_USER_LED, CYBSP_LED_STATE_OFF);
    for (;;)
    {
        printf("[ERROR] %s: 0x%08lx\n", step, (unsigned long)result);
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

static void network_event(cy_wcm_event_t event, cy_wcm_event_data_t *data)
{
    (void)data;
    if (event == CY_WCM_EVENT_DISCONNECTED)
        printf("[Wi-Fi] Connection lost. Waiting for automatic reconnect.\n");
    else if (event == CY_WCM_EVENT_RECONNECTED)
        printf("[Wi-Fi] Reconnected.\n");
    else if (event == CY_WCM_EVENT_IP_CHANGED)
        printf("[Wi-Fi] IP address changed; status follows shortly.\n");
}

static const char *security_name(cy_wcm_security_t security)
{
    switch (security)
    {
        case CY_WCM_SECURITY_WPA2_AES_PSK: return "WPA2-AES-Personal";
        case CY_WCM_SECURITY_WPA2_MIXED_PSK: return "WPA2-AES/TKIP-Personal";
        case CY_WCM_SECURITY_WPA2_WPA_AES_PSK: return "WPA/WPA2-AES-Personal";
        case CY_WCM_SECURITY_WPA2_WPA_MIXED_PSK: return "WPA/WPA2-AES/TKIP-Personal";
        case CY_WCM_SECURITY_WPA3_WPA2_PSK: return "WPA2/WPA3-Personal";
        case CY_WCM_SECURITY_WPA3_SAE: return "WPA3-SAE";
        case CY_WCM_SECURITY_WPA2_AES_ENT: return "WPA2-Enterprise";
        case CY_WCM_SECURITY_OPEN: return "Open";
        default: return "Other";
    }
}

static unsigned scan_network_count;
static unsigned scan_match_count;

static void scan_result(cy_wcm_scan_result_t *result, void *task,
                        cy_wcm_scan_status_t status)
{
    if (status == CY_WCM_SCAN_COMPLETE)
    {
        printf("[SCAN] Nearby 2.4 GHz networks: %u; configured network matches: %u.\n",
               scan_network_count, scan_match_count);
        printf("[SCAN] Scan complete.\n");
        xTaskNotifyGive((TaskHandle_t)task);
    }
    else if (result != NULL)
    {
        ++scan_network_count;
        /* Scan all nearby radios, but never print network names or keys. */
        if (strcmp((const char *)result->SSID, wifi_ssid) != 0)
            return;
        ++scan_match_count;
        printf("[SCAN] Configured network found: channel %u, signal %d dBm, %s (0x%08lx).\n",
               (unsigned)result->channel, (int)result->signal_strength,
               security_name(result->security), (unsigned long)result->security);
    }
}

static void wifi_task(void *argument)
{
    (void)argument;
    const size_t ssid_length = strlen(wifi_ssid);
    const size_t password_length = strlen(wifi_password);
    if (ssid_length == 0 || ssid_length > CY_WCM_MAX_SSID_LEN ||
        password_length < CY_WCM_MIN_PASSPHRASE_LEN || password_length > CY_WCM_MAX_PASSPHRASE_LEN)
    {
        for (;;)
        {
            printf("[SETUP] Run python3 configure_wifi.py, then make -j8 program.\n");
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }

    cy_wcm_config_t config = {.interface = CY_WCM_INTERFACE_TYPE_STA};
    cy_rslt_t result = cy_wcm_init(&config);
    if (result != CY_RSLT_SUCCESS)
        stop_task("Wi-Fi initialization", result);

    result = cy_wcm_register_event_callback(network_event);
    if (result != CY_RSLT_SUCCESS)
        stop_task("Event registration", result);

    cy_wcm_scan_filter_t filter = {.mode = CY_WCM_SCAN_FILTER_TYPE_BAND};
    filter.param.band = CY_WCM_WIFI_BAND_2_4GHZ;
    printf("[SCAN] Checking nearby 2.4 GHz radios and the configured network.\n");
    result = cy_wcm_start_scan(scan_result, xTaskGetCurrentTaskHandle(), &filter);
    if (result != CY_RSLT_SUCCESS)
        printf("[SCAN] Could not start scan: 0x%08lx.\n", (unsigned long)result);
    else if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(15000)) == 0)
    {
        cy_wcm_stop_scan();
        printf("[SCAN] Scan timed out. Proceeding with connection attempt.\n");
    }

    cy_wcm_connect_params_t params = {0};
    memcpy(params.ap_credentials.SSID, wifi_ssid, ssid_length + 1);
    memcpy(params.ap_credentials.password, wifi_password, password_length + 1);
    /* WCM scans the configured SSID to select its advertised security mode. */
    params.ap_credentials.security = CY_WCM_SECURITY_UNKNOWN;
    params.band = CY_WCM_WIFI_BAND_2_4GHZ;
    /* NULL static_ip_settings requests an address using DHCP. */
    cy_wcm_ip_address_t address = {0};
    unsigned long attempt = 0;
    do
    {
        /* Hotspot security can change when compatibility mode is toggled. */
        params.ap_credentials.security = CY_WCM_SECURITY_UNKNOWN;
        printf("[Wi-Fi] Connecting (attempt %lu, 2.4 GHz / security auto-detect)...\n", ++attempt);
        result = cy_wcm_connect_ap(&params, &address);
        if (result == CY_RSLT_WCM_SECURITY_NOT_FOUND)
        {
            /* A directed discovery scan can miss a temporarily hidden hotspot.
             * Try the WPA2-AES mode previously confirmed on this iPhone.
             * This still performs the complete WPA2 authentication exchange. */
            printf("[Wi-Fi] Security discovery found no matching network; this is before password authentication.\n");
            printf("[Wi-Fi] Trying direct WPA2-AES connection with normal authentication.\n");
            params.ap_credentials.security = CY_WCM_SECURITY_WPA2_AES_PSK;
            result = cy_wcm_connect_ap(&params, &address);
        }
        if (result != CY_RSLT_SUCCESS)
        {
            printf("[Wi-Fi] Connect failed: 0x%08lx. Retry in 5 seconds.\n",
                   (unsigned long)result);
            printf("[Wi-Fi] Connection is not established; the LED remains off until an IPv4 address is acquired.\n");
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    } while (result != CY_RSLT_SUCCESS);

    result = cy_log_init(CY_LOG_ERR, NULL, NULL);
    if (result != CY_RSLT_SUCCESS)
        stop_task("TLS error logging initialization", result);
    result = cy_socket_init();
    if (result != CY_RSLT_SUCCESS)
        stop_task("Secure sockets initialization", result);
    bool clock_ready = false;
    bool server_checked = false;
    unsigned retry_ticks = 0;

    /* WCM handles reconnects after the initial successful connection. */
    for (;;)
    {
        memset(&address, 0, sizeof(address));
        result = cy_wcm_get_ip_addr(CY_WCM_INTERFACE_TYPE_STA, &address);
        bool ready = cy_wcm_is_connected_to_ap() && result == CY_RSLT_SUCCESS
                     && address.version == CY_WCM_IP_VER_V4 && address.ip.v4 != 0;
        cyhal_gpio_write(CYBSP_USER_LED, ready ? CYBSP_LED_STATE_ON : CYBSP_LED_STATE_OFF);
        if (ready)
        {
            /* v4 is stored in network byte order; reading its bytes is endian-safe. */
            unsigned char octets[4];
            memcpy(octets, &address.ip.v4, sizeof(octets));
            printf("[OK] Wi-Fi connected + DHCP OK. IP: %u.%u.%u.%u\n",
                   (unsigned)octets[0], (unsigned)octets[1],
                   (unsigned)octets[2], (unsigned)octets[3]);
            if (retry_ticks == 0)
            {
                if (!clock_ready)
                    clock_ready = door_clock_sync();
                server_checked = false;
                if (clock_ready)
                {
                    printf("[SERVER] Check started.\n");
                    server_checked = door_server_check();
                }
                printf("[SERVER] Check complete: %s. Next check in 60 seconds.\n",
                       server_checked ? "passed" : "failed");
                /* Repeat actual HTTPS requests, even after a successful check. */
                retry_ticks = 6;
            }
            if (server_checked)
                printf("[SERVER] Last HTTPS health/status check: passed.\n");
            if (retry_ticks > 0)
                --retry_ticks;
        }
        else
        {
            printf("[WAIT] Waiting for Wi-Fi connection / IPv4 address.\n");
            server_checked = false;
            retry_ticks = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

int main(void)
{
    cy_rslt_t result = cybsp_init();
    if (result != CY_RSLT_SUCCESS)
        for (;;) { }

    result = cyhal_gpio_init(CYBSP_USER_LED, CYHAL_GPIO_DIR_OUTPUT,
                            CYHAL_GPIO_DRIVE_STRONG, CYBSP_LED_STATE_OFF);
    if (result != CY_RSLT_SUCCESS)
        for (;;) { }

    /* Do not initialize the user button: its pin is shared with Wi-Fi host wake. */
    __enable_irq();
    result = cy_retarget_io_init(CYBSP_DEBUG_UART_TX, CYBSP_DEBUG_UART_RX,
                                CY_RETARGET_IO_BAUDRATE);
    if (result != CY_RSLT_SUCCESS)
        for (;;) { }

    printf("\nCY8CPROTO-062-4343W Wi-Fi / Door API HTTPS test\n");
    printf("UART: 115200 baud. Country: Japan.\n");
    if (xTaskCreate(wifi_task, "WiFi", 6144, NULL, 3, NULL) != pdPASS)
    {
        printf("[ERROR] Cannot create Wi-Fi task.\n");
        for (;;) { }
    }
    vTaskStartScheduler();
    printf("[ERROR] FreeRTOS scheduler could not start.\n");
    for (;;) { }
}
