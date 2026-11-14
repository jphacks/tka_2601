#ifndef DOOR_MBEDTLS_USER_CONFIG_H
#define DOOR_MBEDTLS_USER_CONFIG_H

/* Keep Infineon's target, entropy and acceleration configuration. */
#include "configs/mbedtls_user_config.h"

/* door_clock synchronizes the RTC before opening an HTTPS connection. */
#define MBEDTLS_HAVE_TIME_DATE

/* Google Trust Services Root R4 uses the NIST P-384 curve. */
#define MBEDTLS_ECP_DP_SECP384R1_ENABLED

#endif
