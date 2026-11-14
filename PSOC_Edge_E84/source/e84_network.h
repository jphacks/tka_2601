#pragma once
#include <stdbool.h>
bool e84_network_voice_ready(void);
void e84_network_task(void *argument);
void e84_console_task(void *argument);
void e84_m5_task(void *argument);
