#include "device_mode.h"
#include "api_settings.h"
#include "bounded_json.h"
#include "xlog.h"
#include <stdatomic.h>

static const char *const names[] = {NULL, "normal", "omakase", "away", "off"};
/* The network task writes, the voice task reads. 0 = not initialized yet. */
static _Atomic uint8_t current_mode;

bool device_mode_from_name(const char *name, device_mode_t *out) {
    if(!name) return false;
    for(unsigned i=DEVICE_MODE_NORMAL;i<=DEVICE_MODE_OFF;++i)
        if(!strcmp(name,names[i])) { *out=(device_mode_t)i; return true; }
    return false;
}
const char *device_mode_name(device_mode_t mode) {
    return mode>=DEVICE_MODE_NORMAL && mode<=DEVICE_MODE_OFF ? names[mode] : "unknown";
}
static bool take(json_t *j, uint8_t c) { space(j); if(j->p==j->end || *j->p!=c) return false; ++j->p; return true; }
device_mode_parse_t device_mode_parse(const uint8_t *json, size_t length, device_mode_t *out) {
    if(!json || !out || !length || length>4096) return DEVICE_MODE_PARSE_INVALID;
    json_t j={.p=json,.end=json+length,.node_limit=128,.depth_limit=6};
    if(!take(&j,'{')) return DEVICE_MODE_PARSE_INVALID;
    unsigned fields=0; bool done=false, paired=false, mode_null=false;
    device_mode_t mode=0;
    while(!done) {
        char name[32], value[16];
        space(&j); if(!string(&j,name,sizeof(name)) || !take(&j,':')) return DEVICE_MODE_PARSE_INVALID;
        unsigned bit=!strcmp(name,"contract_version")?1:!strcmp(name,"paired")?2:!strcmp(name,"mode")?4:0;
        if(bit && (fields&bit)) return DEVICE_MODE_PARSE_INVALID;
        fields|=bit; space(&j);
        if(bit==1) { uint32_t version; if(!integer(&j,&version) || version!=1) return DEVICE_MODE_PARSE_INVALID; }
        else if(bit==2) {
            if(literal(&j,"true")) paired=true;
            else if(!literal(&j,"false")) return DEVICE_MODE_PARSE_INVALID;
        } else if(bit==4) {
            if(literal(&j,"null")) mode_null=true;
            else if(!string(&j,value,sizeof(value)) || !device_mode_from_name(value,&mode)) return DEVICE_MODE_PARSE_INVALID;
        } else if(!skip(&j,0)) return DEVICE_MODE_PARSE_INVALID;
        space(&j); if(j.p==j.end) return DEVICE_MODE_PARSE_INVALID;
        if(*j.p=='}') { ++j.p; done=true; }
        else if(*j.p++!=',') return DEVICE_MODE_PARSE_INVALID;
    }
    space(&j);
    if(j.p!=j.end || fields!=7) return DEVICE_MODE_PARSE_INVALID;
    /* An unpaired device has no household mode, so mode must be null. A paired
     * device without a valid mode is a malformed response, never "off". */
    if(!paired) return mode_null ? DEVICE_MODE_PARSE_UNPAIRED : DEVICE_MODE_PARSE_INVALID;
    if(mode_null) return DEVICE_MODE_PARSE_INVALID;
    *out=mode; return DEVICE_MODE_PARSE_OK;
}
void device_mode_init(void) {
    uint8_t stored=0; device_mode_t mode;
    if(device_mode_store_read(&stored) && stored>=DEVICE_MODE_NORMAL && stored<=DEVICE_MODE_OFF) {
        current_mode=stored;
        xlog("[MODE] Using last saved mode: %s\n",device_mode_name((device_mode_t)stored));
    } else if(device_mode_from_name(DOOR_RELAY_MODE,&mode)) {
        current_mode=mode;
        xlog("[MODE] No saved mode; using build-time default: %s\n",device_mode_name(mode));
    } else {
        /* Same outcome as before: an invalid build setting never starts a call. */
        current_mode=DEVICE_MODE_OFF;
        xlog("[MODE] DOOR_RELAY_MODE is invalid; calls stay off until the mode is fetched.\n");
    }
}
device_mode_t device_mode_current(void) {
    uint8_t value=current_mode;
    if(!value) { device_mode_init(); value=current_mode; }
    return (device_mode_t)value;
}
const char *device_mode_relay_name(void) { return device_mode_name(device_mode_current()); }
bool device_mode_accepts_calls(void) { return device_mode_current()!=DEVICE_MODE_OFF; }
bool device_mode_gate_call(bool requested) {
    if(!requested) return false;
    if(device_mode_accepts_calls()) return true;
    xlog("[MODE] Stop mode: chime/call request ignored.\n");
    return false;
}
bool device_mode_apply(device_mode_t mode) {
    if(mode<DEVICE_MODE_NORMAL || mode>DEVICE_MODE_OFF) return false;
    device_mode_t before=device_mode_current();
    current_mode=(uint8_t)mode;
    if(before!=mode) xlog("[MODE] Mode changed: %s -> %s\n",device_mode_name(before),device_mode_name(mode));
    /* Compare with what is actually stored, so a failed write is retried by the
     * next fetch and an unchanged mode costs no flash write. */
    uint8_t stored=0;
    if(device_mode_store_read(&stored) && stored==mode) return true;
    bool saved=device_mode_store_write((uint8_t)mode);
    if(!saved) xlog("[MODE] Mode applied but not saved; will retry.\n");
    return saved;
}
