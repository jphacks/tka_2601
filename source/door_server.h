#ifndef DOOR_SERVER_H
#define DOOR_SERVER_H

#include <stdbool.h>

/* Call from a task after Wi-Fi, cy_socket_init(), and clock synchronization. */
bool door_server_check(void);

#endif
