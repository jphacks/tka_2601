#include "pusher_protocol.h"
#include "bounded_json.h"
#include <stdio.h>

static bool take(json_t *j, uint8_t c) { space(j); if(j->p==j->end || *j->p!=c) return false; ++j->p; return true; }
static bool key(json_t *j, char *name, size_t size) { space(j); return string(j,name,size) && take(j,':'); }
static bool next(json_t *j, bool *done) {
    space(j); if(j->p==j->end) return false;
    if(*j->p=='}') { ++j->p; *done=true; return true; }
    if(*j->p++!=',') return false;
    *done=false; return true;
}
static bool pusher(json_t *j, uint8_t *id) {
    char value[4]; space(j); if(!string(j,value,sizeof(value))) return false;
    if(!strcmp(value,"p1")) *id=1; else if(!strcmp(value,"p2")) *id=2; else return false;
    return true;
}
static bool enabled(json_t *j, uint8_t *mask) {
    if(!take(j,'[')) return false;
    *mask=0;
    for(unsigned count=0;count<2;++count) {
        uint8_t id;
        if(!pusher(j,&id) || (*mask & (1u<<(id-1)))) return false;
        *mask |= 1u<<(id-1);
        space(j); if(j->p==j->end) return false;
        if(*j->p==']') { ++j->p; return true; }
        if(*j->p++!=',') return false;
    }
    return false;
}
static bool assignments(json_t *j, servo_pusher_config_t *config) {
    if(!take(j,'{')) return false;
    unsigned fields=0; bool done=false;
    while(!done) {
        char name[24]; if(!key(j,name,sizeof(name))) return false;
        unsigned bit=!strcmp(name,"call_start")?1:!strcmp(name,"call_end")?2:0;
        if(!bit || (fields&bit)) return false;
        fields|=bit;
        if(!pusher(j,bit==1?&config->call_start:&config->call_end) || !next(j,&done)) return false;
    }
    return fields==3;
}
static bool config_read(json_t *j, servo_pusher_config_t *config) {
    if(!take(j,'{')) return false;
    unsigned fields=0; bool done=false;
    while(!done) {
        char name[24]; if(!key(j,name,sizeof(name))) return false;
        unsigned bit=!strcmp(name,"schema_version")?1:!strcmp(name,"enabled_pushers")?2:!strcmp(name,"assignments")?4:0;
        if(!bit || (fields&bit)) return false;
        fields|=bit; space(j);
        if(bit==1) { uint32_t version; if(!integer(j,&version) || version>UINT16_MAX) return false; config->schema_version=(uint16_t)version; }
        else if(bit==2) { if(!enabled(j,&config->enabled_mask)) return false; }
        else if(!assignments(j,config)) return false;
        if(!next(j,&done)) return false;
    }
    if(fields!=7) return false;
    unsigned start=1u<<(config->call_start-1), end=1u<<(config->call_end-1);
    return (config->enabled_mask&start) && (config->enabled_mask&end) &&
           (config->enabled_mask==3 ? config->call_start!=config->call_end : config->call_start==config->call_end);
}
static bool snapshot_read(json_t *j, servo_pusher_config_t *config, bool *local) {
    space(j); if(literal(j,"null")) { *local=true; return true; }
    if(!take(j,'{')) return false;
    unsigned fields=0; bool done=false, config_null=false;
    while(!done) {
        char name[64]; if(!key(j,name,sizeof(name))) return false;
        unsigned bit=!strcmp(name,"desired_revision")?1:!strcmp(name,"desired_config")?2:0;
        if(bit && (fields&bit)) return false;
        fields|=bit; space(j);
        if(bit==1) { if(!integer(j,&config->revision)) return false; }
        else if(bit==2) {
            if(literal(j,"null")) config_null=true;
            else if(!config_read(j,config)) return false;
        } else if(!skip(j,0)) return false;
        if(!next(j,&done)) return false;
    }
    if(fields!=3 || (config_null ? config->revision!=0 : config->revision==0)) return false;
    *local=config_null; return true;
}
pusher_settings_result_t pusher_settings_parse(const uint8_t *json, size_t length, servo_pusher_config_t *out) {
    if(!json || !out || !length || length>4096) return PUSHER_SETTINGS_INVALID;
    json_t j={.p=json,.end=json+length,.node_limit=512,.depth_limit=12};
    servo_pusher_config_t candidate={0};
    if(!take(&j,'{')) return PUSHER_SETTINGS_INVALID;
    unsigned fields=0; bool done=false, paired=false, local=false;
    while(!done) {
        char name[64]; if(!key(&j,name,sizeof(name))) return PUSHER_SETTINGS_INVALID;
        unsigned bit=!strcmp(name,"paired")?1:!strcmp(name,"pusher_settings")?2:0;
        if(bit && (fields&bit)) return PUSHER_SETTINGS_INVALID;
        fields|=bit; space(&j);
        if(bit==1) {
            if(literal(&j,"true")) paired=true;
            else if(!literal(&j,"false")) return PUSHER_SETTINGS_INVALID;
        } else if(bit==2) { if(!snapshot_read(&j,&candidate,&local)) return PUSHER_SETTINGS_INVALID; }
        else if(!skip(&j,0)) return PUSHER_SETTINGS_INVALID;
        if(!next(&j,&done)) return PUSHER_SETTINGS_INVALID;
    }
    space(&j); if(j.p!=j.end || !(fields&1)) return PUSHER_SETTINGS_INVALID;
    if(!paired) return PUSHER_SETTINGS_UNPAIRED;
    if(!(fields&2)) return PUSHER_SETTINGS_MISSING;
    if(local) return PUSHER_SETTINGS_LOCAL;
    *out=candidate; return PUSHER_SETTINGS_CONFIG;
}
size_t pusher_status_encode(char *out, size_t capacity, const servo_pusher_config_t *actual,
                           const char *error, bool recovery, unsigned pin1, unsigned pin2) {
    if(!out || !capacity) return 0;
    if(error) for(const char *p=error;*p;++p) if(!((*p>='a'&&*p<='z')||*p=='_')) return 0;
    char applied[384];
    int encoded;
    if(actual) {
        const char *enabled=actual->enabled_mask==1?"\"p1\"":actual->enabled_mask==2?"\"p2\"":"\"p1\",\"p2\"";
        encoded=snprintf(applied,sizeof(applied),
            "\"applied_revision\":%lu,\"applied_config\":{\"schema_version\":%u,\"enabled_pushers\":[%s],"
            "\"assignments\":{\"call_start\":\"p%u\",\"call_end\":\"p%u\"}}",
            (unsigned long)actual->revision,actual->schema_version,enabled,actual->call_start,actual->call_end);
    } else encoded=snprintf(applied,sizeof(applied),"\"applied_revision\":null,\"applied_config\":null");
    if(encoded<0 || (size_t)encoded>=sizeof(applied)) return 0;
    int n=snprintf(out,capacity,
        "{%s,\"apply_error\":%s%s%s,\"runtime_status\":\"%s\",\"capabilities\":{\"schema_versions\":[1],\"pushers\":["
        "{\"id\":\"p1\",\"gpio\":%u},{\"id\":\"p2\",\"gpio\":%u}]}}",
        applied,error?"\"":"null",error?error:"",error?"\"":"",recovery?"manual_check_required":"normal",pin1,pin2);
    return n>0 && (size_t)n<capacity?(size_t)n:0;
}
