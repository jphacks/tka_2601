#include "voice_noise_config.h"
#include "audio_app.h"
#include "voice_stream.h"
#include "playback.h"
#include "xlog.h"
#include <Preferences.h>
#include <cstring>
namespace {
struct Config {uint32_t version,enabled;};
bool saved=false;
bool read(Config &value) {
 Preferences prefs;
 if(!prefs.begin("monban-noise",true))return false;
 bool ok=prefs.getBytesLength("control")==sizeof(value) &&
  prefs.getBytes("control",&value,sizeof(value))==sizeof(value) && value.version==1 && value.enabled<=1;
 prefs.end();return ok;
}
bool write(const Config &value) {
 Preferences prefs;if(!prefs.begin("monban-noise",false))return false;
 Config verified{};
 bool ok=prefs.putBytes("control",&value,sizeof(value))==sizeof(value) &&
  prefs.getBytes("control",&verified,sizeof(verified))==sizeof(verified) && !memcmp(&value,&verified,sizeof(value));
 prefs.end();return ok;
}
}
void voice_noise_config_begin() {
 Config value{};saved=read(value) && value.enabled;
 if(saved && !audio_app_post_command('N'))xlog("[NOISE] saved_enabled=1 queued=0; runtime remains OFF.\n");
}
bool voice_noise_config_command(const char *command) {
 if(strncmp(command,"@noise ",7))return false;
 if(!strcmp(command,"@noise status")) {
  xlog("[NOISE] saved_enabled=%u queued=%u.\n",saved?1u:0u,audio_app_post_command('J')?1u:0u);return true;
 }
 bool enabled=!strcmp(command,"@noise on");
 if(!enabled && strcmp(command,"@noise off")){xlog("[NOISE] invalid_command.\n");return true;}
 if(voice_stream_busy() || !playback_idle()){xlog("[NOISE] busy; setting unchanged.\n");return true;}
 Config previous{};bool valid=read(previous);
 const Config next{1,enabled?1u:0u};
 if((!valid || previous.enabled!=next.enabled) && !write(next)) {
  xlog("[NOISE] save_failed; runtime setting unchanged.\n");return true;
 }
 saved=enabled;
 bool queued=audio_app_post_command(enabled?'N':'n');
 xlog("[NOISE] saved_enabled=%u queued=%u; experimental idle-profile suppression.\n",saved?1u:0u,queued?1u:0u);
 return true;
}
