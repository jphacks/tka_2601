#include "voice_call_diag.h"
#include "xlog.h"
#include <Preferences.h>
#include <cstring>
namespace {
struct Record {uint32_t version;voice_call_diag_t data;};
static_assert(sizeof(Record)==40,"Diagnostic contains only ten uint32 fields");
/* Append only; saved numeric meanings remain stable. */
const char *const reasons[]={"none","unknown","completed","manual_stop","network_lost",
 "capture_pause_failed","api_settings_missing","server_connect_failed","server_ready_failed",
 "servo_busy","call_button_failed","agent_start_failed","end_button_failed",
 "server_connection_lost","server_protocol_error","server_send_failed","playback_failed",
 "microphone_start_failed","microphone_or_send_failed","device_time_limit",
 "speech_wait_timeout","response_timeout","server_keepalive_timeout","keepalive_send_failed",
 "speaker_busy","audio_queue_full","speaker_start_failed","speaker_progress_timeout",
 "speaker_short_write","playback_psram_allocation_failed"};
}
uint32_t voice_call_diag_reason(const char *reason) {
 if(!reason)return 0;
 for(unsigned i=0;i<sizeof(reasons)/sizeof(reasons[0]);++i)if(!strcmp(reason,reasons[i]))return i;
 return 1;
}
bool voice_call_diag_store(const voice_call_diag_t *snapshot) {
 if(!snapshot)return false;
 const Record record{1,*snapshot};Record verified{};Preferences prefs;
 if(!prefs.begin("monban-call",false))return false;
 bool ok=prefs.putBytes("last",&record,sizeof(record))==sizeof(record) &&
   prefs.getBytes("last",&verified,sizeof(verified))==sizeof(verified) && !memcmp(&record,&verified,sizeof(record));
 prefs.end();return ok;
}
bool voice_call_diag_command(const char *command) {
 if(strcmp(command,"@voice-call status"))return false;
 Record record{};Preferences prefs;
 bool ok=prefs.begin("monban-call",true);
 if(ok){ok=prefs.getBytesLength("last")==sizeof(record) && prefs.getBytes("last",&record,sizeof(record))==sizeof(record) && record.version==1;prefs.end();}
 if(!ok){xlog("[VOICE CALL] saved=0.\n");return true;}
 const auto &d=record.data;
 const char *name=d.reason<sizeof(reasons)/sizeof(reasons[0])?reasons[d.reason]:"unknown";
 xlog("[VOICE CALL] saved=1 reason=%s reason_code=%lu phase=%lu turn=%lu input_frames=%lu input_end_sent=%lu started_ms=%lu greeting_ms=%lu input_end_ms=%lu ended_ms=%lu.\n",
   name,(unsigned long)d.reason,(unsigned long)d.phase,(unsigned long)d.turn,(unsigned long)d.input_frames,
   (unsigned long)d.input_end_sent,(unsigned long)d.started_ms,(unsigned long)d.greeting_ms,
   (unsigned long)d.input_end_ms,(unsigned long)d.ended_ms);
 return true;
}
