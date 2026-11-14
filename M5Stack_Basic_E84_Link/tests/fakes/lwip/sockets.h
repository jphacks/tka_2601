#pragma once
#include <stddef.h>
#define MSG_DONTWAIT 0x40
int e84FakeSend(int, const void*, size_t, int);
#define send e84FakeSend
