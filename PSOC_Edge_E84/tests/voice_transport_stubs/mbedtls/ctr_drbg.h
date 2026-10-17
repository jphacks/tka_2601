#pragma once
#include <stddef.h>
typedef struct { unsigned initialized; } mbedtls_ctr_drbg_context;
void mbedtls_ctr_drbg_init(mbedtls_ctr_drbg_context *context);
void mbedtls_ctr_drbg_free(mbedtls_ctr_drbg_context *context);
int mbedtls_ctr_drbg_seed(mbedtls_ctr_drbg_context *context,int (*entropy)(void *,unsigned char *,size_t),void *source,const unsigned char *personal,size_t length);
int mbedtls_ctr_drbg_random(void *context,unsigned char *output,size_t length);
