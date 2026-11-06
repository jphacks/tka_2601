#include "device_mode.h"
/* In-memory stand-in for the NVS hooks in device_mode_store.cpp. */
unsigned fake_mode_reads, fake_mode_writes;
bool fake_mode_stored, fake_mode_fail_write;
uint8_t fake_mode_value;
bool device_mode_store_read(uint8_t *value)
{ ++fake_mode_reads; if(!fake_mode_stored) return false; *value=fake_mode_value; return true; }
bool device_mode_store_write(uint8_t value)
{
    if(fake_mode_fail_write) return false;
    ++fake_mode_writes; fake_mode_stored=true; fake_mode_value=value; return true;
}
