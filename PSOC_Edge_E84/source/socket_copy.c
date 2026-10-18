/* Secure Sockets 3.12.2's network_send calls netconn_write_partly with flags=0
 * (NOCOPY). Voice packets and TLS records use temporary buffers, so queued TCP
 * retransmissions must own a copy after cy_socket_send returns. Apply this at
 * the public lwIP boundary without modifying the fetched vendor sources.
 * The CM33_NS linker uses --wrap=netconn_write_partly for this shim. */
#include "lwip/api.h"

err_t __real_netconn_write_partly(struct netconn *conn, const void *data,
    size_t size, u8_t flags, size_t *written);

err_t __wrap_netconn_write_partly(struct netconn *conn, const void *data,
    size_t size, u8_t flags, size_t *written)
{
    return __real_netconn_write_partly(conn,data,size,flags|NETCONN_COPY,written);
}
