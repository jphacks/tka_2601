#pragma once
#include <stddef.h>
int mbedtls_sha1(const unsigned char *input,size_t length,unsigned char output[20]);
