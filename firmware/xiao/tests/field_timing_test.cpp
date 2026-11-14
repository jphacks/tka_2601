#include "field_timing.h"
#include <Preferences.h>
#include <cassert>
#include <cstdio>
#include <cstdarg>
extern "C" void xlog(const char *format, ...) {
    va_list args; va_start(args,format); vprintf(format,args); va_end(args);
}
int main() {
    field_timing_event("call_start",0,1000,100000);
    field_timing_event("call_press_requested",0,1100,100100);
    field_timing_event("playback_start",0,2100,101100);
    field_timing_event("speech_end",1,3000,102000);
    field_timing_event("reply_start",1,4300,103300);
    field_timing_event("playback_start",1,4550,103550);
    for (unsigned i=0;i<55;++i) field_timing_event("listen_start",2,4600+i,103600+i);
    field_timing_event("call_end",2,5000,104000);
    assert(fake::storageWrites==0);
    field_timing_save();
    assert(fake::storageWrites==1);
    field_timing_event("call_start",0,10,0);  // RAM belongs to a subsequent boot/call
    field_timing_print();
    assert(fake::storageWrites==1);
}
