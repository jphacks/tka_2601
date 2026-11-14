#include "voice_call_diag.h"
#include <Preferences.h>
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <string>
static std::string logs;
extern "C" void xlog(const char *format,...){char line[800];va_list args;va_start(args,format);vsnprintf(line,sizeof(line),format,args);va_end(args);logs+=line;}
int main() {
 static_assert(sizeof(voice_call_diag_t)==36,"Only requested fixed numeric fields");
 assert(voice_call_diag_reason(nullptr)==0 && voice_call_diag_reason("arbitrary_private_text")==1);
 assert(voice_call_diag_reason("device_time_limit")==19);
 assert(!voice_call_diag_store(nullptr));
 assert(!voice_call_diag_command("@unrelated"));voice_call_diag_command("@voice-call status");
 assert(logs.find("saved=0")!=std::string::npos);
 fake::preferenceRecords["monban-tune/settings"]={1,2,3};
 voice_call_diag_t d{19,2,1,75,1,1000,2000,4000,51000};
 assert(voice_call_diag_store(&d));assert(fake::preferenceRecords["monban-call/last"].size()==40);
 auto first=fake::preferenceRecords["monban-call/last"];
 auto count=fake::storageWrites;
 logs.clear();voice_call_diag_command("@voice-call status");voice_call_diag_command("@voice-call status");
 assert(fake::storageWrites==count);
 assert(logs.find("reason=device_time_limit reason_code=19 phase=2 turn=1 input_frames=75 input_end_sent=1")!=std::string::npos);
 assert(logs.find("started_ms=1000 greeting_ms=2000 input_end_ms=4000 ended_ms=51000")!=std::string::npos);
 assert(logs.find("arbitrary_private_text")==std::string::npos);
 fake::failWriteKey="last";assert(!voice_call_diag_store(&d));fake::failWriteKey.clear();
 assert(fake::preferenceRecords["monban-call/last"]==first);
 fake::failStorage=true;assert(!voice_call_diag_store(&d));fake::failStorage=false;
 assert(fake::preferenceRecords["monban-tune/settings"]==std::vector<unsigned char>({1,2,3}));
 puts("PASS: actual40byte last-call NVS, fixed reason IDs, numeric-only USB read, read-only status, storage failure and other namespaces preserved");
}
