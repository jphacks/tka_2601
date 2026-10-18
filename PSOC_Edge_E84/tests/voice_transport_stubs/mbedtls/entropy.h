#pragma once
#include <stddef.h>
typedef struct { unsigned initialized; } mbedtls_entropy_context;
void mbedtls_entropy_init(mbedtls_entropy_context *context);
void mbedtls_entropy_free(mbedtls_entropy_context *context);
int mbedtls_entropy_func(void *context,unsigned char *output,size_t length);
