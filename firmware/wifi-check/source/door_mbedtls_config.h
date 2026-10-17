#pragma once
#include "mbedtls_user_config.h"

/* Validate certificate dates as well as chain and hostname. */
#define MBEDTLS_HAVE_TIME_DATE

/* GTS Root R4 / WE1 certificates use the NIST P-384 curve. */
#define MBEDTLS_ECP_DP_SECP384R1_ENABLED
