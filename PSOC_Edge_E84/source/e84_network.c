#include "e84_network.h"
#include "e84_wifi_hw.h"
#include "e84_shared.h"
#include "audio_store.h"
#include "audio_upload.h"
#include "wifi_settings.h"
#include "wifi_reconnect.h"
#include "door_clock.h"
#include "door_server.h"
#include "m5_link.h"
#include "voice_stream.h"
#include "cybsp.h"
#include "cy_wcm.h"
#include "cy_secure_sockets.h"
#include "FreeRTOS.h"
#include "task.h"
#include "mbedtls/entropy.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

static volatile bool sockets_ready, network_ready;
static volatile bool voice_clock_ready;
bool e84_network_voice_ready(void)
{
    return sockets_ready && network_ready && voice_clock_ready && cy_wcm_is_connected_to_ap();
}
/* Console is the sole request writer; the M5 task acknowledges after handling.
 * Keep at most one probe in flight, independently of the CM55 audio mailbox. */
static volatile uint32_t m5_probe_request, m5_probe_ack;
static volatile bool api_probe_requested;

static void report_wifi(void)
{
    cy_wcm_ip_address_t address={0}, gateway={0};
    cy_wcm_associated_ap_info_t ap={0};
    bool associated=cy_wcm_is_connected_to_ap()!=0;
    bool has_ip=cy_wcm_get_ip_addr(CY_WCM_INTERFACE_TYPE_STA,&address)==CY_RSLT_SUCCESS &&
        address.version==CY_WCM_IP_VER_V4 && address.ip.v4!=0;
    (void)cy_wcm_get_gateway_ip_address(CY_WCM_INTERFACE_TYPE_STA,&gateway);
    bool has_rssi=associated && cy_wcm_get_associated_ap_info(&ap)==CY_RSLT_SUCCESS;
    const unsigned char *ip=(const unsigned char *)&address.ip.v4;
    const unsigned char *gw=(const unsigned char *)&gateway.ip.v4;
    printf("[DIAG] wifi {\"connected\":%s,\"ip\":\"%u.%u.%u.%u\",\"gateway\":\"%u.%u.%u.%u\",\"rssi\":%d,\"rssi_valid\":%s}\n",
        associated&&has_ip?"true":"false",ip[0],ip[1],ip[2],ip[3],gw[0],gw[1],gw[2],gw[3],
        has_rssi?ap.signal_strength:0,has_rssi?"true":"false");
}

/* The producer holds the shared clip until a successful HTTPS ACK. Reuse the
 * original bounded WAV/CRC reader without reserving or erasing XIP flash. */
static bool shared_pcm_read(uint32_t offset, void *out, size_t size)
{
    volatile e84_shared_t *s = e84_shared();
    uint32_t base = AUDIO_EVENT_FIRST_SLOT * AUDIO_SLOT_SIZE + AUDIO_BODY_OFFSET;
    if (s->clip_samples > AUDIO_CLIP_SAMPLES || offset < base) return false;
    offset -= base;
    uint32_t bytes = s->clip_samples * sizeof(int16_t);
    if (offset > bytes || size > bytes - offset) return false;
    volatile const uint8_t *pcm = (volatile const uint8_t *)s->clip_pcm;
    uint8_t *target = out;
    for (size_t i = 0; i < size; ++i) target[i] = pcm[offset + i];
    return true;
}

static bool upload_pending(void)
{
    volatile e84_shared_t *s = e84_shared();
    uint32_t sequence = s->clip_seq;
    e84_shared_acquire();
    if (!sequence || sequence == s->clip_ack || !audio_upload_configured()) return false;
    if (!s->clip_samples || s->clip_samples > AUDIO_CLIP_SAMPLES || !isfinite(s->clip_score)) {
        printf("[UPLOAD] Invalid shared clip; retained for diagnosis.\n");
        return false;
    }
    audio_store_t store = {0};
    unsigned slot = AUDIO_EVENT_FIRST_SLOT;
    store.ready = true;
    store.flash.read = shared_pcm_read;
    store.valid[slot] = true;
    store.record[slot].samples = s->clip_samples;
    store.record[slot].length = s->clip_samples * sizeof(int16_t);
    store.record[slot].score = s->clip_score;
    store.record[slot].crc = s->clip_crc;
    for (unsigned i = 0; i < 4; ++i) store.record[slot].id[i] = s->clip_id[i];
    if (!audio_store_verify(&store, slot)) {
        printf("[UPLOAD] Shared recording CRC failed; not sent.\n");
        return false;
    }
    if (!audio_upload(&store, slot)) return false;
    e84_shared_release();
    s->clip_ack = sequence;
    e84_shared_release();
    printf("[UPLOAD] Server acknowledged recording %lu; releasing RAM slot.\n", (unsigned long)sequence);
    return true;
}

static bool publish_boot_nonce(void)
{
    uint32_t nonce[3];
    mbedtls_entropy_context entropy;
    mbedtls_entropy_init(&entropy);
    int result = mbedtls_entropy_func(&entropy, (unsigned char *)nonce, sizeof(nonce));
    mbedtls_entropy_free(&entropy);
    if (result != 0) return false;
    volatile e84_shared_t *s = e84_shared();
    for (unsigned i = 0; i < 3; ++i) s->seed[i] = nonce[i];
    e84_shared_release();
    s->seed_ready = 1;
    e84_shared_release();
    return true;
}

static cy_rslt_t connect_once(cy_wcm_connect_params_t *params,
                             cy_wcm_ip_address_t *address, unsigned long *attempts,
                             bool recovery)
{
    /* Explicit WPA2 skips WCM's security-discovery scans for a phone configured
     * for compatibility mode. On recovery, reuse the security selected by the
     * successful connection to avoid scanning alongside WCM's retry worker. */
    if (!recovery) params->ap_credentials.security = wifi_security;
    printf("[Wi-Fi] Connecting (attempt %lu, 2.4 GHz, %s)...\n", ++*attempts,
           wifi_hotspot_compatibility ? "hotspot WPA2-AES" :
           recovery ? "previous security settings" : "automatic security selection");
    cy_rslt_t result = cy_wcm_connect_ap(params, address);
    if (!wifi_hotspot_compatibility && result == CY_RSLT_WCM_SECURITY_NOT_FOUND) {
        params->ap_credentials.security = CY_WCM_SECURITY_WPA2_AES_PSK;
        result = cy_wcm_connect_ap(params, address);
    }
    return result;
}

void e84_network_task(void *argument)
{
    (void)argument;
    printf("[BOOT] Network task running.\n");
    size_t ssid_length = strlen(wifi_ssid), password_length = strlen(wifi_password);
    if (!ssid_length || ssid_length > CY_WCM_MAX_SSID_LEN ||
        password_length < CY_WCM_MIN_PASSPHRASE_LEN || password_length > CY_WCM_MAX_PASSPHRASE_LEN) {
        printf("[SETUP] Configure Wi-Fi with python3 configure_wifi.py and rebuild. Audio continues offline.\n");
        vTaskDelete(NULL);
    }
    printf("[BOOT] Initializing Wi-Fi driver...\n");
    cy_rslt_t result = e84_wifi_init();
    if (result != CY_RSLT_SUCCESS) {
        printf("[ERROR] Wi-Fi initialization: 0x%08lx\n", (unsigned long)result);
        vTaskDelete(NULL);
    }
    printf("[BOOT] Wi-Fi driver ready. Initializing secure sockets...\n");
    result = cy_socket_init();
    if (result != CY_RSLT_SUCCESS) {
        printf("[ERROR] Secure sockets initialization: 0x%08lx\n", (unsigned long)result);
        vTaskDelete(NULL);
    }
    printf("[BOOT] Secure sockets ready. Generating recording ID seed...\n");
    sockets_ready = true;
    while (!publish_boot_nonce()) {
        printf("[ERROR] Entropy unavailable; retaining recordings locally.\n");
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
    printf("[BOOT] Recording ID seed ready.\n");
    cy_wcm_connect_params_t params = {0};
    memcpy(params.ap_credentials.SSID, wifi_ssid, ssid_length + 1);
    memcpy(params.ap_credentials.password, wifi_password, password_length + 1);
    params.band = CY_WCM_WIFI_BAND_2_4GHZ;
    cy_wcm_ip_address_t address = {0};
    unsigned long attempts = 0;
    if (wifi_hotspot_compatibility)
        printf("[Wi-Fi] Hotspot mode: 2.4 GHz / WPA2-AES. Enable Maximize Compatibility on iPhone and keep Personal Hotspot settings open.\n");
    do {
        result = connect_once(&params, &address, &attempts, false);
        if (result != CY_RSLT_SUCCESS) {
            printf("[Wi-Fi] Connect failed: 0x%08lx; retry in 5 seconds.\n", (unsigned long)result);
            if (wifi_hotspot_compatibility)
                printf("[Wi-Fi] Check hotspot availability, 2.4 GHz/WPA2 settings, network name and password. No board reset is needed to retry.\n");
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    } while (result != CY_RSLT_SUCCESS);

    bool clock_ready = false, previously_ready = false;
    unsigned health_delay = 0, upload_delay = 0;
    wifi_reconnect_t reconnect = {0};
    for (;;) {
        memset(&address, 0, sizeof(address));
        result = cy_wcm_get_ip_addr(CY_WCM_INTERFACE_TYPE_STA, &address);
        bool associated = cy_wcm_is_connected_to_ap() != 0;
        bool ready = associated && result == CY_RSLT_SUCCESS &&
                     address.version == CY_WCM_IP_VER_V4 && address.ip.v4 != 0;
        network_ready = ready;
        Cy_GPIO_Write(CYBSP_USER_LED1_PORT, CYBSP_USER_LED1_PIN,
                      ready ? CYBSP_LED_STATE_ON : CYBSP_LED_STATE_OFF);
        if (ready && !previously_ready) {
            const unsigned char *octets = (const unsigned char *)&address.ip.v4;
            printf("[OK] Wi-Fi connected + DHCP OK. IP: %u.%u.%u.%u\n",
                   octets[0], octets[1], octets[2], octets[3]);
            health_delay = upload_delay = 0;
        } else if (!ready && previously_ready) {
            printf("[Wi-Fi] Connection lost; WCM will reconnect. If using a phone, enable its hotspot again.\n");
        }
        previously_ready = ready;
        if (wifi_reconnect_due(&reconnect, associated, (uint32_t)xTaskGetTickCount(),
                               (uint32_t)pdMS_TO_TICKS(60000))) {
            /* WCM handles beacon-loss retries. Generic AP-initiated disconnects
             * may stop those retries; recover from our sole connection task.
             * v4.1 serializes public connect and internal retries with its mutex
             * and is_connect_triggered flag. No driver deinit/disconnect here. */
            if (!cy_wcm_is_connected_to_ap()) {
                printf("[Wi-Fi] Still disconnected after 60 seconds; requesting a fresh connection.\n");
                result = connect_once(&params, &address, &attempts, true);
                if (result != CY_RSLT_SUCCESS)
                    printf("[Wi-Fi] Reconnect failed: 0x%08lx; next recovery attempt in 60 seconds.\n",
                           (unsigned long)result);
                else health_delay = upload_delay = 0;
            }
            wifi_reconnect_attempt_finished(&reconnect, (uint32_t)xTaskGetTickCount());
        }
        if (api_probe_requested) {
            api_probe_requested=false;
            if (voice_stream_busy()) printf("[DIAG] api_https busy\n");
            else if (!ready) printf("[DIAG] api_https network_not_ready\n");
            else {
                printf("[DIAG] api_https checking\n");
                if (!clock_ready) clock_ready=door_clock_sync();
                voice_clock_ready=clock_ready;
                bool ok=clock_ready && door_server_check();
                printf("[DIAG] api_https ok=%u\n",ok?1u:0u);
                health_delay=60;
            }
        }
        if (ready) {
            if (!health_delay && !voice_stream_busy()) {
                if (!clock_ready) clock_ready = door_clock_sync();
                voice_clock_ready = clock_ready;
                if (clock_ready) (void)door_server_check();
                health_delay = 60;
            }
            if (clock_ready && !upload_delay && !voice_stream_busy()) {
                bool acknowledged = upload_pending();
                upload_delay = acknowledged ? 1 : 5;
            }
        }
        if (health_delay) --health_delay;
        if (upload_delay) --upload_delay;
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void e84_console_task(void *argument)
{
    (void)argument;
    volatile e84_shared_t *s = e84_shared();
    TickType_t last_status = xTaskGetTickCount();
    uint32_t last_heartbeat = UINT32_MAX;
    uint32_t last_detection = 0;
    printf("[E84] c=streaming call, q=end call, t=test M5 Wi-Fi, r=record 5s, x=cancel recording, e=rearm, s=status, h=help.\n");
    for (;;) {
        bool status = false;
        while (Cy_SCB_UART_GetNumInRxFifo(CYBSP_DEBUG_UART_HW)) {
            uint32_t input = Cy_SCB_UART_Get(CYBSP_DEBUG_UART_HW);
            if (input == 's') status = true;
            else if (input == 'u') printf("[DIAG] usb ok=1\n");
            else if (input == 'n') report_wifi();
            else if (input == 'a') {
                if (voice_stream_busy()) printf("[DIAG] api_https busy\n");
                else if (api_probe_requested) printf("[DIAG] api_https already_running\n");
                else api_probe_requested=true;
            }
            else if (input == 'w') {
                if (voice_stream_busy()) printf("[API WSS] busy\n");
                else voice_stream_request_api_probe();
            }
            else if (input == 'h' || input == '?')
                printf("[E84] c=streaming call (M5 servo acts); q=end call; t=test M5 Wi-Fi; r=record 5s; x=cancel; e=rearm; s=status. RAM queue is lost on reset.\n");
            else if (input == 'c') {
                if (voice_stream_busy()) printf("[VOICE] Call already active or recovery required.\n");
                else voice_stream_request_call();
            }
            else if (input == 'q') voice_stream_request_stop();
            else if (input == 'v') {
                if (voice_stream_busy()) printf("[M5 TCP] Test unavailable during call/recovery.\n");
                else voice_stream_request_probe();
            }
            else if (input == 't') {
                if (!m5_link_configured())
                    printf("[M5] Configure the M5 IP with python3 configure_m5.py --host <M5_IP>, then rebuild/program.\n");
                else if (!sockets_ready || !network_ready)
                    printf("[M5] Wi-Fi is not ready. Press t again after connection.\n");
                else if (m5_probe_request != m5_probe_ack)
                    printf("[M5] A communication test is already running.\n");
                else if (m5_probe_request == UINT32_MAX)
                    printf("[M5] Diagnostic ID limit reached. Restart before another test.\n");
                else ++m5_probe_request;
            }
            else if (input == 'r' || input == 'x' || input == 'e') {
                if (voice_stream_busy()) {
                    printf("[VOICE] Legacy audio commands disabled during call. Use q to end.\n");
                    continue;
                }
                e84_shared_acquire();
                if (s->command_seq != s->command_ack) printf("[E84] Audio command still pending.\n");
                else {
                    s->command = input;
                    e84_shared_release();
                    ++s->command_seq;
                    e84_shared_release();
                }
            }
        }
        TickType_t now = xTaskGetTickCount();
        e84_shared_acquire();
        if (s->detected_count != last_detection) {
            last_detection = s->detected_count;
            printf("[DETECTED] Chime count=%lu; capturing the following 1 second.\n",
                   (unsigned long)last_detection);
        }
        bool periodic = now - last_status >= pdMS_TO_TICKS(10000);
        if (status || periodic) {
            e84_shared_acquire();
            printf("[AUDIO] state=%lu detected=%lu queued=%lu discarded=%lu rms=%.0f distance=%.3f gaps=%lu drops=%lu pcm=%ld..%ld\n",
                (unsigned long)s->audio_status, (unsigned long)s->detected_count,
                (unsigned long)s->queued_count, (unsigned long)s->dropped_clips,
                (double)s->last_rms, (double)s->last_score,
                (unsigned long)s->capture_errors, (unsigned long)s->capture_drops,
                (long)s->pcm_min,(long)s->pcm_max);
            if (periodic) {
                if (s->audio_status == 1 && s->heartbeat == last_heartbeat)
                    printf("[ERROR] Audio heartbeat stopped; inspect capture/core startup and reset.\n");
                last_heartbeat = s->heartbeat;
                last_status = now;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void e84_m5_task(void *argument)
{
    (void)argument;
    volatile e84_shared_t *s = e84_shared();
    uint32_t observed = 0;
    bool was_available = false;
    for (;;) {
        bool available = sockets_ready && network_ready && m5_link_configured() &&
                         cy_wcm_is_connected_to_ap();
        uint32_t request = m5_probe_request;
        if (request != m5_probe_ack) {
            e84_shared_acquire();
            if (available && s->seed_ready) {
                /* Separate probe IDs from recording/chime IDs; no microphone
                 * command, detection, recording or M5 actuation is triggered. */
                uint32_t id[4] = {s->seed[0] ^ UINT32_C(0x4d355049),
                                  s->seed[1], s->seed[2], request};
                (void)m5_link_probe(id);
            } else {
                printf("[M5] Test skipped: Wi-Fi or random ID seed is not ready. Press t to retry.\n");
            }
            m5_probe_ack = request;
            /* Do not forward a chime that arrived while the diagnostic task
             * was busy and may now be stale. Fresh events resume next poll. */
            was_available = false;
            available = false;
        }
        {
            uint32_t guard = s->event_guard;
            e84_shared_acquire();
            uint32_t sequence = s->event_seq, id[4];
            float score = s->event_score;
            for (unsigned i = 0; i < 4; ++i) id[i] = s->event_id[i];
            e84_shared_acquire();
            if (!(guard & 1u) && guard == s->event_guard && sequence && sequence != observed) {
                /* Consume even while offline. Never replay a stale chime after
                 * reconnect, or retry an event indefinitely into a future call. */
                observed = sequence;
                if (available && was_available && !voice_stream_busy() && m5_link_send(id, score)) {
                    printf("[M5] Chime %lu sent by UDP (delivery unconfirmed).\n", (unsigned long)sequence);
                }
            }
        }
        was_available = available;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
