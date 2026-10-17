/* Real m5_link.c with a deterministic, nonblocking lwIP/FreeRTOS boundary. */
#include "probe_test_network.h"
#include "m5_link.h"
#include "m5_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum scenario {
    SUCCESS, TIMEOUT, WRONG_PEER, WRONG_PORT, WRONG_TOKEN, WRONG_ID,
    PING_REPLY, TRAILING_DATA, TRUNCATED_PACKET, PARTIAL_COPY,
    INVALID_THEN_VALID, RECEIVE_FLOOD, SEND_FAILURE, SOCKET_FAILURE,
    BUFFER_FAILURE, REF_FAILURE, BIND_FAILURE, RECEIVE_FAILURE,
    RECEIVE_FAILURE_WITH_BUFFER, NULL_RECEIVE, NO_INTERFACE, INTERFACE_DOWN,
    LINK_DOWN, NO_ADDRESS, OFF_SUBNET, SELF_ADDRESS, DIRECTED_BROADCAST,
    CLOCK_WRAP, SCENARIO_COUNT
};

static const char token[] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static const uint32_t id[4] = {0x01234567, 0x89abcdef, 0, 0xffffffff};
static const uint32_t destination_address = 0xc0a8013f; /* 192.168.1.63 */
const ip_addr_t probe_any_address = {0};
static struct netif interface = {{0xc0a80102}, {0xffffff00}, true, true};
static enum scenario scenario;
static unsigned allocations, connections, locks, sends, polls, replies;
static TickType_t clock_now, clock_started, send_times[3];

int ip4addr_aton(const char *text, ip4_addr_t *address)
{
    unsigned a, b, c, d;
    if (sscanf(text, "%u.%u.%u.%u", &a, &b, &c, &d) != 4 ||
        a > 255 || b > 255 || c > 255 || d > 255) return 0;
    address->addr = a << 24 | b << 16 | c << 8 | d;
    return 1;
}

int ip4_addr_isbroadcast(const ip4_addr_t *address, const struct netif *network)
{
    return address->addr == (network->address.addr | ~network->mask.addr);
}

void probe_lock(void) { assert(locks++ == 0); }
void probe_unlock(void) { assert(locks-- == 1); }

struct netif *cy_network_get_nw_interface(int kind, int index)
{
    assert(kind == CY_NETWORK_WIFI_STA_INTERFACE && index == 0);
    return scenario == NO_INTERFACE ? NULL : &interface;
}

void cy_network_activity_notify(int activity)
{
    assert(activity == CY_NETWORK_ACTIVITY_TX || activity == CY_NETWORK_ACTIVITY_RX);
}

struct netconn *netconn_new(int kind)
{
    assert(kind == NETCONN_UDP && locks == 0);
    if (scenario == SOCKET_FAILURE) return NULL;
    struct netconn *connection = calloc(1, sizeof(*connection));
    assert(connection);
    ++connections;
    return connection;
}

void netconn_set_nonblocking(struct netconn *connection, int nonblocking)
{
    assert(connection && nonblocking);
    connection->nonblocking = true;
}

void netconn_set_sendtimeout(struct netconn *connection, int milliseconds)
{
    assert(connection && milliseconds > 0 && milliseconds <= 100);
}

void netconn_set_recvtimeout(struct netconn *connection, int milliseconds)
{
    assert(connection && milliseconds >= 0 && milliseconds <= 100);
}

err_t netconn_bind(struct netconn *connection, const ip_addr_t *address, u16_t port)
{
    assert(connection && connection->nonblocking && address->addr == 0 && port == 0);
    return scenario == BIND_FAILURE ? ERR_MEM : ERR_OK;
}

err_t netconn_delete(struct netconn *connection)
{
    assert(connection && connections == 1);
    --connections;
    free(connection);
    return ERR_OK;
}

struct netbuf *netbuf_new(void)
{
    if (scenario == BUFFER_FAILURE) return NULL;
    struct netbuf *buffer = calloc(1, sizeof(*buffer));
    assert(buffer);
    ++allocations;
    return buffer;
}

err_t netbuf_ref(struct netbuf *buffer, const void *payload, u16_t length)
{
    assert(buffer && payload && length);
    if (scenario == REF_FAILURE) return ERR_MEM;
    buffer->payload = payload;
    buffer->length = length;
    return ERR_OK;
}

u16_t netbuf_copy(struct netbuf *buffer, void *destination, u16_t length)
{
    assert(buffer && destination && length <= buffer->length);
    memcpy(destination, buffer->payload, length);
    return scenario == PARTIAL_COPY ? length - 1 : length;
}

void netbuf_delete(struct netbuf *buffer)
{
    assert(buffer && allocations);
    if (buffer->owns_payload) free((void *)buffer->payload);
    free(buffer);
    --allocations;
}

err_t netconn_sendto(struct netconn *connection, struct netbuf *buffer,
                     const ip_addr_t *address, u16_t port)
{
    assert(connection && connection->nonblocking && locks == 0);
    assert(address->addr == destination_address && port == 8768);
    char expected[192];
    size_t length = m5_probe_format(expected, sizeof(expected), id, token, false);
    assert(buffer->length == length && memcmp(buffer->payload, expected, length) == 0);
    assert(sends < 3);
    send_times[sends++] = clock_now - clock_started;
    return scenario == SEND_FAILURE ? ERR_MEM : ERR_OK;
}

static struct netbuf *reply_buffer(enum scenario variant)
{
    struct netbuf *buffer = netbuf_new();
    assert(buffer);
    char reply[256];
    uint32_t reply_id[4];
    memcpy(reply_id, id, sizeof(id));
    if (variant == WRONG_ID) ++reply_id[3];
    char reply_token[sizeof(token)];
    memcpy(reply_token, token, sizeof(token));
    if (variant == WRONG_TOKEN) reply_token[0] = 'f';
    size_t length = m5_probe_format(reply, sizeof(reply), reply_id, reply_token,
                                   variant != PING_REPLY);
    assert(length);
    if (variant == TRAILING_DATA) reply[length++] = '\0';
    if (variant == TRUNCATED_PACKET) --length;
    void *data = malloc(length);
    assert(data);
    memcpy(data, reply, length);
    buffer->payload = data;
    buffer->length = (u16_t)length;
    buffer->owns_payload = true;
    buffer->peer.addr = destination_address + (variant == WRONG_PEER ? 1 : 0);
    buffer->port = variant == WRONG_PORT ? 9999 : 8768;
    ++replies;
    return buffer;
}

err_t netconn_recv(struct netconn *connection, struct netbuf **buffer)
{
    assert(connection && connection->nonblocking && locks == 0 && sends > 0);
    assert(++polls <= 200); /* An incoming flood must not defeat the deadline. */
    *buffer = NULL;
    if (scenario == RECEIVE_FAILURE) return ERR_CONN;
    if (scenario == RECEIVE_FAILURE_WITH_BUFFER) {
        *buffer = reply_buffer(SUCCESS);
        return ERR_CONN;
    }
    if (scenario == NULL_RECEIVE) return ERR_OK;
    if (scenario == RECEIVE_FLOOD) {
        *buffer = reply_buffer(WRONG_PEER);
        return ERR_OK;
    }
    if (scenario == INVALID_THEN_VALID && replies < 5) {
        static const enum scenario variants[] = {
            WRONG_PEER, WRONG_PORT, WRONG_TOKEN, WRONG_ID, SUCCESS
        };
        *buffer = reply_buffer(variants[replies]);
        return ERR_OK;
    }
    if (scenario <= PARTIAL_COPY && scenario != TIMEOUT && replies == 0) {
        *buffer = reply_buffer(scenario);
        return ERR_OK;
    }
    return ERR_WOULDBLOCK;
}

TickType_t xTaskGetTickCount(void) { return clock_now; }

void vTaskDelay(TickType_t duration)
{
    assert(duration > 0 && duration <= 100);
    clock_now += duration;
    assert((TickType_t)(clock_now - clock_started) <= 1600);
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    scenario = (enum scenario)atoi(argv[1]);
    assert(scenario >= SUCCESS && scenario < SCENARIO_COUNT);
    if (scenario == INTERFACE_DOWN) interface.up = false;
    if (scenario == LINK_DOWN) interface.link = false;
    if (scenario == NO_ADDRESS) interface.address.addr = 0;
    if (scenario == OFF_SUBNET) interface.address.addr = 0xc0a80202;
    if (scenario == SELF_ADDRESS) interface.address.addr = destination_address;
    if (scenario == DIRECTED_BROADCAST) interface.mask.addr = 0xffffffc0;
    if (scenario == CLOCK_WRAP) clock_now = UINT32_MAX - 750;
    clock_started = clock_now;

    assert(m5_link_configured());
    bool success = m5_link_probe(id);
    assert(success == (scenario == SUCCESS || scenario == INVALID_THEN_VALID));
    assert(allocations == 0 && connections == 0 && locks == 0);
    if (success) {
        assert(sends == 1);
        if (scenario == INVALID_THEN_VALID) assert(replies == 5 && clock_now >= 50);
    } else if ((scenario >= TIMEOUT && scenario <= PARTIAL_COPY) ||
               scenario == RECEIVE_FLOOD || scenario == SEND_FAILURE ||
               scenario == NULL_RECEIVE || scenario == CLOCK_WRAP) {
        assert(sends == 3);
        assert(send_times[0] == 0 && send_times[1] == 500 && send_times[2] == 1000);
        assert((TickType_t)(clock_now - clock_started) == 1500);
        if (scenario == RECEIVE_FLOOD) assert(polls == 120);
    } else if (scenario == RECEIVE_FAILURE || scenario == RECEIVE_FAILURE_WITH_BUFFER) {
        assert(sends == 1 && polls == 1);
    } else {
        assert(sends == 0 && polls == 0);
    }
    return 0;
}
