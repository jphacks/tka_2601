#include "door_clock.h"
#include "cy_secure_sockets.h"
#include "mtb_hal.h"
#include "cy_time.h"
#include "mbedtls/entropy.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static uint32_t read_u32(const uint8_t *bytes)
{
    return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16)
           | ((uint32_t)bytes[2] << 8) | bytes[3];
}

static bool query_time(const char *host, time_t *unix_seconds)
{
    cy_socket_t socket = CY_SOCKET_INVALID_HANDLE;
    cy_socket_sockaddr_t server = {.port = 123};
    cy_rslt_t result = cy_socket_gethostbyname(host, CY_SOCKET_IP_VER_V4,
                                            &server.ip_address);
    if (result != CY_RSLT_SUCCESS)
    {
        printf("[TIME] DNS failed for %s: 0x%08lx\n", host, (unsigned long)result);
        return false;
    }
    result = cy_socket_create(CY_SOCKET_DOMAIN_AF_INET, CY_SOCKET_TYPE_DGRAM,
                              CY_SOCKET_IPPROTO_UDP, &socket);
    if (result != CY_RSLT_SUCCESS)
        return false;

    bool valid = false;
    uint32_t timeout_ms = 5000;
    result = cy_socket_setsockopt(socket, CY_SOCKET_SOL_SOCKET, CY_SOCKET_SO_RCVTIMEO,
                                  &timeout_ms, sizeof(timeout_ms));
    if (result != CY_RSLT_SUCCESS)
        goto done;
    result = cy_socket_setsockopt(socket, CY_SOCKET_SOL_SOCKET, CY_SOCKET_SO_SNDTIMEO,
                                  &timeout_ms, sizeof(timeout_ms));
    if (result != CY_RSLT_SUCCESS)
        goto done;

    uint8_t request[48] = {0x23}; /* NTP version 4, client mode. */
    /* Use the same entropy provider as TLS; do not allocate or reset a second
     * hardware random-number generator while TLS may own crypto resources. */
    mbedtls_entropy_context entropy;
    mbedtls_entropy_init(&entropy);
    int entropy_result = mbedtls_entropy_func(&entropy, request + 40, 8);
    mbedtls_entropy_free(&entropy);
    if (entropy_result != 0)
    {
        printf("[TIME] Entropy generation failed: -0x%04x\n", (unsigned)-entropy_result);
        goto done;
    }

    uint32_t count = 0;
    result = cy_socket_sendto(socket, request, sizeof(request), CY_SOCKET_FLAGS_NONE,
                              &server, sizeof(server), &count);
    if (result != CY_RSLT_SUCCESS || count != sizeof(request))
        goto done;

    uint8_t response[64] = {0};
    cy_socket_sockaddr_t sender = {0};
    uint32_t sender_length = sizeof(sender);
    result = cy_socket_recvfrom(socket, response, sizeof(response),
                                CY_SOCKET_FLAGS_RECVFROM_NONE, &sender,
                                &sender_length, &count);
    if (result != CY_RSLT_SUCCESS)
        goto done;

    unsigned version = (response[0] >> 3) & 7;
    if (count < 48 || sender.port != 123 ||
        sender.ip_address.version != CY_SOCKET_IP_VER_V4 ||
        sender.ip_address.ip.v4 != server.ip_address.ip.v4 ||
        (response[0] & 7) != 4 || (response[0] >> 6) == 3 ||
        (version != 3 && version != 4) || response[1] == 0 || response[1] > 15 ||
        memcmp(response + 24, request + 40, 8) != 0)
    {
        printf("[TIME] Invalid NTP response from %s.\n", host);
        goto done;
    }

    uint32_t ntp_seconds = read_u32(response + 40);
    /* Supports the NTP era rollover in 2036; bound results to 2024..2037. */
    uint64_t epoch_seconds = ntp_seconds >= UINT32_C(2208988800)
        ? (uint64_t)ntp_seconds - UINT32_C(2208988800)
        : (uint64_t)ntp_seconds + UINT64_C(4294967296) - UINT32_C(2208988800);
    if (epoch_seconds < UINT64_C(1704067200) || epoch_seconds > UINT64_C(2145916799))
    {
        printf("[TIME] NTP date outside supported range (2024..2037).\n");
        goto done;
    }
    *unix_seconds = (time_t)epoch_seconds;
    valid = true;

done:
    if (result != CY_RSLT_SUCCESS)
        printf("[TIME] %s failed: 0x%08lx\n", host, (unsigned long)result);
    cy_socket_delete(socket);
    return valid;
}

bool door_clock_sync(void)
{
    const char *servers[] = {"time.google.com", "time.cloudflare.com"};
    time_t seconds = 0;
    bool received = false;
    for (size_t i = 0; i < sizeof(servers) / sizeof(servers[0]); ++i)
    {
        printf("[TIME] Synchronizing clock with %s...\n", servers[i]);
        if (query_time(servers[i], &seconds))
        {
            received = true;
            break;
        }
    }
    if (!received)
    {
        printf("[TIME] No valid time received. HTTPS verification will not start.\n");
        return false;
    }

    /* The E84 CM33 startup configures CYBSP_RTC and registers its HAL
     * object with CLIB. TLS time() must read that same physical RTC. */
    mtb_hal_rtc_t *rtc = mtb_clib_support_get_rtc();
    if (rtc == NULL)
    {
        printf("[TIME] RTC is not initialized by CM33 startup. HTTPS stays disabled.\n");
        return false;
    }
    struct tm utc;
    if (gmtime_r(&seconds, &utc) == NULL)
        return false;
    cy_rslt_t result = mtb_hal_rtc_write(rtc, &utc);
    if (result != CY_RSLT_SUCCESS)
    {
        printf("[TIME] RTC write failed: 0x%08lx\n", (unsigned long)result);
        return false;
    }
    printf("[TIME] UTC %04d-%02d-%02d %02d:%02d:%02d\n", utc.tm_year + 1900,
           utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec);
    return true;
}
