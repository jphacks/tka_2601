#include "tune.h"
#include "voice_settings.h"
#include "xlog.h"
#include <Preferences.h>
#include <stdio.h>
#include <string.h>

namespace {
struct Values { uint16_t version, volume, gate, margin; };
// 70% is about half power: the amp can exceed the 1 W speaker at full scale on 5 V.
volatile Values values = {1, 70, VOICE_RMS_GATE, 100};
bool valid(const Values& v) {
  return v.version == 1 && v.volume <= 100 && v.gate >= 30 && v.gate <= 32767 && v.margin >= 50 && v.margin <= 200;
}
void reply(const char* error = nullptr) {
  xlog("[CAL] {\"ok\":%s,\"error\":\"%s\",\"diagnostic\":\"tune\",\"speaker_volume\":%u,\"voice_rms_gate\":%u,\"chime_margin\":%u}\n",
    error ? "false" : "true", error ? error : "", values.volume, values.gate, values.margin);
}
}

extern "C" {
void tune_begin(void) {
  Preferences prefs;
  if (!prefs.begin("monban-tune", true)) return;
  Values stored{};
  if (prefs.getBytesLength("settings") == sizeof(stored) &&
      prefs.getBytes("settings", &stored, sizeof(stored)) == sizeof(stored) && valid(stored)) {
    values.volume = stored.volume; values.gate = stored.gate; values.margin = stored.margin;
  }
  prefs.end();
}
void tune_command(const char* command) {
  if (!strcmp(command, "@tune get")) { reply(); return; }
  char field[8] = {0}, extra = 0; int value = -1;
  if (sscanf(command, "@tune %7s %d %c", field, &value, &extra) != 2) { reply("invalid_tune"); return; }
  Values next{1, values.volume, values.gate, values.margin};
  if (!strcmp(field, "volume") && value >= 0 && value <= 100) next.volume = value;
  else if (!strcmp(field, "gate") && value >= 30 && value <= 32767) next.gate = value;
  else if (!strcmp(field, "margin") && value >= 50 && value <= 200) next.margin = value;
  else { reply("invalid_tune"); return; }
  Preferences prefs;
  if (!prefs.begin("monban-tune", false)) { reply("storage_unavailable"); return; }
  Values verified{};
  const bool written = prefs.putBytes("settings", &next, sizeof(next)) == sizeof(next) &&
    prefs.getBytes("settings", &verified, sizeof(verified)) == sizeof(verified) &&
    !memcmp(&verified, &next, sizeof(next));
  prefs.end();
  if (!written) { reply("save_failed"); return; }
  values.volume = next.volume; values.gate = next.gate; values.margin = next.margin;
  reply();
}
uint32_t tune_speaker_volume(void) { return values.volume; }
uint32_t tune_voice_gate(void) { return values.gate; }
uint32_t tune_chime_margin(void) { return values.margin; }
}
