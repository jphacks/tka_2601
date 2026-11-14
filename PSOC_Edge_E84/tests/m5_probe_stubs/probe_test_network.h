#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

typedef uint16_t u16_t;
typedef int err_t;
typedef uint32_t TickType_t;
typedef struct { uint32_t addr; } ip4_addr_t;
typedef ip4_addr_t ip_addr_t;
struct netif { ip4_addr_t address, mask; bool up, link; };
struct netconn { bool nonblocking; };
struct netbuf {
    const void *payload;
    u16_t length;
    ip_addr_t peer;
    u16_t port;
    bool owns_payload;
};

#define ERR_OK 0
#define ERR_MEM -1
#define ERR_WOULDBLOCK -7
#define ERR_TIMEOUT -3
#define ERR_CONN -11
#define NETCONN_UDP 0x20
#define CY_NETWORK_WIFI_STA_INTERFACE 0
#define CY_NETWORK_ACTIVITY_TX 1
#define CY_NETWORK_ACTIVITY_RX 2
#define pdMS_TO_TICKS(milliseconds) ((TickType_t)(milliseconds))
#define portTICK_PERIOD_MS 1
#define IP_ADDR_ANY (&probe_any_address)
#define LOCK_TCPIP_CORE() probe_lock()
#define UNLOCK_TCPIP_CORE() probe_unlock()
#define ip_2_ip4(address) (address)
#define ip_addr_copy_from_ip4(destination, source) ((destination) = (source))
#define ip_addr_cmp(a, b) ((a)->addr == (b)->addr)
#define ip4_addr_cmp(a, b) ip_addr_cmp(a, b)
#define ip4_addr_isany_val(address) ((address).addr == 0)
#define ip4_addr1(address) (((address)->addr >> 24) & 255u)
#define ip4_addr2(address) (((address)->addr >> 16) & 255u)
#define ip4_addr4(address) ((address)->addr & 255u)
#define ip4_addr_netcmp(a, b, mask) (((a)->addr & (mask)->addr) == ((b)->addr & (mask)->addr))
#define netif_ip4_addr(interface) (&(interface)->address)
#define netif_ip4_netmask(interface) (&(interface)->mask)
#define netif_is_up(interface) ((interface)->up)
#define netif_is_link_up(interface) ((interface)->link)
#define netbuf_fromaddr(buffer) (&(buffer)->peer)
#define netbuf_fromport(buffer) ((buffer)->port)
#define netbuf_len(buffer) ((buffer)->length)

int ip4addr_aton(const char *text, ip4_addr_t *address);
extern const ip_addr_t probe_any_address;
int ip4_addr_isbroadcast(const ip4_addr_t *address, const struct netif *interface);
void probe_lock(void);
void probe_unlock(void);
struct netif *cy_network_get_nw_interface(int interface, int index);
void cy_network_activity_notify(int activity);
struct netconn *netconn_new(int kind);
void netconn_set_nonblocking(struct netconn *connection, int nonblocking);
void netconn_set_sendtimeout(struct netconn *connection, int milliseconds);
void netconn_set_recvtimeout(struct netconn *connection, int milliseconds);
err_t netconn_bind(struct netconn *connection, const ip_addr_t *address, u16_t port);
err_t netconn_sendto(struct netconn *connection, struct netbuf *buffer,
                     const ip_addr_t *address, u16_t port);
err_t netconn_recv(struct netconn *connection, struct netbuf **buffer);
err_t netconn_delete(struct netconn *connection);
struct netbuf *netbuf_new(void);
err_t netbuf_ref(struct netbuf *buffer, const void *payload, u16_t length);
u16_t netbuf_copy(struct netbuf *buffer, void *destination, u16_t length);
void netbuf_delete(struct netbuf *buffer);
TickType_t xTaskGetTickCount(void);
void vTaskDelay(TickType_t duration);
