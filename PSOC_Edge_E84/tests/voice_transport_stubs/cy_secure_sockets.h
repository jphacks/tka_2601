#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef int cy_socket_t;
typedef uint32_t cy_rslt_t;
typedef int cy_socket_tls_auth_mode_t;
typedef struct { uint32_t address; } cy_socket_ip_address_t;
typedef struct { cy_socket_ip_address_t ip_address; uint16_t port; } cy_socket_sockaddr_t;
#define CY_SOCKET_INVALID_HANDLE (-1)
#define CY_RSLT_SUCCESS 0u
#define CY_RSLT_MODULE_SECURE_SOCKETS_TIMEOUT 1u
#define CY_SOCKET_IP_VER_V4 4
#define CY_SOCKET_DOMAIN_AF_INET 2
#define CY_SOCKET_TYPE_STREAM 1
#define CY_SOCKET_IPPROTO_TLS 100
#define CY_SOCKET_IPPROTO_TCP 6
#define CY_SOCKET_SOL_SOCKET 1
#define CY_SOCKET_SOL_TLS 2
#define CY_SOCKET_SO_RCVTIMEO 1
#define CY_SOCKET_SO_SNDTIMEO 2
#define CY_SOCKET_SO_TLS_AUTH_MODE 3
#define CY_SOCKET_SO_TRUSTED_ROOTCA_CERTIFICATE 4
#define CY_SOCKET_SO_SERVER_NAME_INDICATION 5
#define CY_SOCKET_SO_ALPN_PROTOCOLS 6
#define CY_SOCKET_TLS_VERIFY_REQUIRED 1
cy_rslt_t cy_socket_delete(cy_socket_t socket);
cy_rslt_t cy_socket_setsockopt(cy_socket_t socket,int level,int name,const void *value,uint32_t length);
cy_rslt_t cy_socket_send(cy_socket_t socket,const void *data,uint32_t length,int flags,uint32_t *sent);
cy_rslt_t cy_socket_recv(cy_socket_t socket,void *data,uint32_t length,int flags,uint32_t *received);
cy_rslt_t cy_socket_gethostbyname(const char *host,int version,cy_socket_ip_address_t *address);
cy_rslt_t cy_socket_create(int domain,int type,int protocol,cy_socket_t *socket);
cy_rslt_t cy_socket_connect(cy_socket_t socket,const cy_socket_sockaddr_t *address,uint32_t length);
