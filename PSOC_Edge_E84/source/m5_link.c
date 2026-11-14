#include "m5_link.h"
#include "m5_protocol.h"
#include "m5_settings.h"
#include "cy_network_mw_core.h"
#include "lwip/api.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"
#include "lwip/tcpip.h"
#include "FreeRTOS.h"
#include "task.h"
#include <stdio.h>
#include <string.h>

static bool destination(ip_addr_t *address)
{
    ip4_addr_t v4;
    if (!M5_IPV4[0] || M5_PORT < 1024u || M5_PORT > 65535u ||
        !ip4addr_aton(M5_IPV4, &v4)) return false;
    unsigned a = ip4_addr1(&v4), b = ip4_addr2(&v4), last = ip4_addr4(&v4);
    if (!((a == 10u) || (a == 172u && b >= 16u && b <= 31u) ||
          (a == 192u && b == 168u)) || last == 0u || last == 255u) return false;
    ip_addr_copy_from_ip4(*address, v4);
    return true;
}

bool m5_link_configured(void)
{
    ip_addr_t address;
    char probe[256];
    const uint32_t id[4] = {0};
    return destination(&address) &&
        m5_message_format(probe, sizeof(probe), id, 0.0f, M5_TOKEN) != 0u;
}

static bool local_destination(ip_addr_t *address)
{
    if (!destination(address)) return false;

    /* Reject directed broadcast, off-subnet destinations and our own address
     * using the actual DHCP subnet, not an assumed /24 network. */
    struct netif *interface = cy_network_get_nw_interface(CY_NETWORK_WIFI_STA_INTERFACE, 0);
    if (!interface) return false;
    LOCK_TCPIP_CORE();
    bool local = netif_is_up(interface) && netif_is_link_up(interface) &&
        !ip4_addr_isany_val(*netif_ip4_addr(interface)) &&
        ip4_addr_netcmp(ip_2_ip4(address), netif_ip4_addr(interface), netif_ip4_netmask(interface)) &&
        !ip4_addr_isbroadcast(ip_2_ip4(address), interface) &&
        !ip4_addr_cmp(ip_2_ip4(address), netif_ip4_addr(interface));
    UNLOCK_TCPIP_CORE();
    if (!local) {
        printf("[M5] Destination is not a different unicast host on the connected LAN.\n");
        return false;
    }
    return true;
}

bool m5_link_destination_is_local(void)
{
    ip_addr_t address;
    return local_destination(&address);
}

bool m5_link_send(const uint32_t id[4], float score)
{
    ip_addr_t address;
    char message[256];
    if (!local_destination(&address)) return false;
    size_t length = m5_message_format(message, sizeof(message), id, score, M5_TOKEN);
    if (!length) return false;

    /* cy_socket_sendto() performs its own blocking 30-second ARP resolution,
     * even for a nonblocking socket. Use the same lwIP stack's netconn UDP API
     * instead: unresolved ARP is queued/dropped by lwIP without a network wait.
     * This runs in a dedicated task, never the microphone or upload task. */
    cy_network_activity_notify(CY_NETWORK_ACTIVITY_TX);
    struct netconn *connection = netconn_new(NETCONN_UDP);
    if (!connection) return false;
    netconn_set_nonblocking(connection, 1);
    netconn_set_sendtimeout(connection, 100);
    struct netbuf *buffer = netbuf_new();
    bool submitted = false;
    unsigned count = 0;
    if (buffer && netbuf_ref(buffer, message, (u16_t)length) == ERR_OK) {
        for (unsigned attempt = 0; attempt < 3u; ++attempt) {
            if (netconn_sendto(connection, buffer, &address, (u16_t)M5_PORT) == ERR_OK) {
                submitted = true;
                ++count;
            }
        }
    }
    if (buffer) netbuf_delete(buffer);
    netconn_delete(connection);
    printf("[M5] Submitted %u/3 chime datagrams; delivery unconfirmed.\n", count);
    return submitted;
}

bool m5_link_probe(const uint32_t id[4])
{
    ip_addr_t address;
    char message[192];
    if (!local_destination(&address)) return false;
    size_t length = m5_probe_format(message, sizeof(message), id, M5_TOKEN, false);
    if (!length) return false;
    struct netconn *connection = netconn_new(NETCONN_UDP);
    if (!connection) {
        printf("[M5] Cannot allocate the diagnostic UDP socket.\n");
        return false;
    }
    netconn_set_nonblocking(connection, 1);
    netconn_set_sendtimeout(connection, 100);
    struct netbuf *outgoing = netbuf_new();
    bool success = false;
    unsigned submitted = 0;
    if (!outgoing || netbuf_ref(outgoing, message, (u16_t)length) != ERR_OK ||
        netconn_bind(connection, IP_ADDR_ANY, 0) != ERR_OK) {
        printf("[M5] Cannot prepare the diagnostic UDP socket.\n");
        goto cleanup;
    }

    printf("[M5] Testing %s:%u; waiting for authenticated pong...\n", M5_IPV4, (unsigned)M5_PORT);
    TickType_t started = xTaskGetTickCount();
    unsigned attempts = 0;
    while ((TickType_t)(xTaskGetTickCount() - started) < pdMS_TO_TICKS(1500)) {
        TickType_t elapsed = xTaskGetTickCount() - started;
        if (attempts < 3u && elapsed >= pdMS_TO_TICKS(500u * attempts)) {
            cy_network_activity_notify(CY_NETWORK_ACTIVITY_TX);
            if (netconn_sendto(connection, outgoing, &address, (u16_t)M5_PORT) == ERR_OK)
                ++submitted;
            ++attempts;
        }
        /* Bound each polling pass even if unrelated packets arrive nonstop. */
        for (unsigned received = 0; received < 4u; ++received) {
            struct netbuf *incoming = NULL;
            err_t result = netconn_recv(connection, &incoming);
            if (result != ERR_OK) {
                if (incoming) netbuf_delete(incoming);
                if (result == ERR_WOULDBLOCK || result == ERR_TIMEOUT) break;
                printf("[M5] Diagnostic UDP receive failed (%d).\n", (int)result);
                goto cleanup;
            }
            if (!incoming) break;
            char reply[192];
            size_t reply_length = netbuf_len(incoming);
            bool valid = reply_length == length && reply_length < sizeof(reply) &&
                ip_addr_cmp(netbuf_fromaddr(incoming), &address) &&
                netbuf_fromport(incoming) == M5_PORT &&
                netbuf_copy(incoming, reply, (u16_t)reply_length) == reply_length &&
                m5_probe_reply_matches(reply, reply_length, id, M5_TOKEN);
            netbuf_delete(incoming);
            if (valid) {
                printf("[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.\n");
                success = true;
                goto cleanup;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    printf("[M5] No authenticated reply (%u/3 pings submitted). Check M5 IP, shared token and hotspot peer access.\n", submitted);
cleanup:
    if (outgoing) netbuf_delete(outgoing);
    netconn_delete(connection);
    return success;
}
