#include "voice_noise_config.h"
#include <Preferences.h>
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <string>
static bool busy=false,idle=true,queue_ok=true;
static unsigned queued=0;
static char last;
static std::string logs;
extern "C" bool voice_stream_busy(){return busy;}
extern "C" bool playback_idle(){return idle;}
extern "C" bool audio_app_post_command(char c){if(!queue_ok)return false;last=c;++queued;return true;}
extern "C" void xlog(const char *format,...){char line[800];va_list args;va_start(args,format);vsnprintf(line,sizeof(line),format,args);va_end(args);logs+=line;}
int main() {
 fake::preferenceRecords["monban-tune/settings"]={1,2,3};
 fake::preferenceRecords["monban-servo/settings"]={4,5,6};
 voice_noise_config_begin();assert(!queued);
 assert(!voice_noise_config_command("@unrelated"));
 assert(voice_noise_config_command("@noise on"));assert(queued==1 && last=='N');
 auto writes=fake::storageWrites;voice_noise_config_command("@noise on");assert(fake::storageWrites==writes);
 queued=0;voice_noise_config_begin();assert(queued==1 && last=='N');
 busy=true;voice_noise_config_command("@noise off");assert(fake::storageWrites==writes && last=='N');busy=false;
 idle=false;voice_noise_config_command("@noise off");assert(fake::storageWrites==writes);idle=true;
 fake::failWriteKey="control";voice_noise_config_command("@noise off");assert(last=='N');fake::failWriteKey.clear();
 voice_noise_config_command("@noise off");assert(last=='n');
 queued=0;voice_noise_config_begin();assert(!queued);
 queue_ok=false;voice_noise_config_command("@noise on");assert(logs.find("saved_enabled=1 queued=0")!=std::string::npos);
 queue_ok=true;voice_noise_config_begin();assert(last=='N');
 assert(fake::preferenceRecords["monban-tune/settings"]==std::vector<unsigned char>({1,2,3}));
 assert(fake::preferenceRecords["monban-servo/settings"]==std::vector<unsigned char>({4,5,6}));
 puts("PASS: experimental noise explicit opt-in/defaultOFF, reload, dedup, busy/storage/queue failures, other NVS keys preserved");
}
