#pragma once
#include <stddef.h>
int mbedtls_base64_encode(unsigned char *output,size_t capacity,size_t *written,const unsigned char *input,size_t length);
