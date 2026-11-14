#include "chime_enroll_protocol.h"
#include "bounded_json.h"
#include <stdio.h>

static bool take(json_t *j, uint8_t c) { space(j); if(j->p==j->end || *j->p!=c) return false; ++j->p; return true; }

chime_enroll_parse_t chime_enroll_parse(const uint8_t *json, size_t length, chime_enroll_request_t *out) {
    if(!json || !out || !length || length>4096) return CHIME_ENROLL_PARSE_INVALID;
    json_t j={.p=json,.end=json+length,.node_limit=128,.depth_limit=6};
    if(!take(&j,'{')) return CHIME_ENROLL_PARSE_INVALID;
    unsigned fields=0; bool done=false, paired=false, seq_null=false, action_null=false;
    uint32_t seq=0; chime_enroll_action_t action=CHIME_ENROLL_ACTION_NONE;
    while(!done) {
        char name[32], value[16];
        space(&j); if(!string(&j,name,sizeof(name)) || !take(&j,':')) return CHIME_ENROLL_PARSE_INVALID;
        unsigned bit=!strcmp(name,"contract_version")?1:!strcmp(name,"paired")?2:!strcmp(name,"request_seq")?4:
            !strcmp(name,"action")?8:0;
        if(bit && (fields&bit)) return CHIME_ENROLL_PARSE_INVALID;
        fields|=bit; space(&j);
        if(bit==1) { uint32_t version; if(!integer(&j,&version) || version!=1) return CHIME_ENROLL_PARSE_INVALID; }
        else if(bit==2) {
            if(literal(&j,"true")) paired=true;
            else if(!literal(&j,"false")) return CHIME_ENROLL_PARSE_INVALID;
        } else if(bit==4) {
            if(literal(&j,"null")) seq_null=true;
            else if(!integer(&j,&seq)) return CHIME_ENROLL_PARSE_INVALID;
        } else if(bit==8) {
            if(literal(&j,"null")) action_null=true;
            else if(!string(&j,value,sizeof(value))) return CHIME_ENROLL_PARSE_INVALID;
            else if(!strcmp(value,"start")) action=CHIME_ENROLL_ACTION_START;
            else if(!strcmp(value,"cancel")) action=CHIME_ENROLL_ACTION_CANCEL;
            else return CHIME_ENROLL_PARSE_INVALID;
        } else if(!skip(&j,0)) return CHIME_ENROLL_PARSE_INVALID;
        space(&j); if(j.p==j.end) return CHIME_ENROLL_PARSE_INVALID;
        if(*j.p=='}') { ++j.p; done=true; }
        else if(*j.p++!=',') return CHIME_ENROLL_PARSE_INVALID;
    }
    space(&j);
    if(j.p!=j.end || fields!=15) return CHIME_ENROLL_PARSE_INVALID;
    if(!paired) {
        if(!action_null) return CHIME_ENROLL_PARSE_INVALID;
        out->request_seq=0; out->action=CHIME_ENROLL_ACTION_NONE;
        return CHIME_ENROLL_PARSE_UNPAIRED;
    }
    if(seq_null) return CHIME_ENROLL_PARSE_INVALID;
    out->request_seq=seq; out->action=action_null?CHIME_ENROLL_ACTION_NONE:action;
    return CHIME_ENROLL_PARSE_OK;
}

static const char *const phase_names[] = {"idle","noise","listen","analyze","saving","done","failed","cancelled"};
static const char *const reason_names[] = {NULL,"too_noisy","too_short","clipped","no_recording","unstable","background_matches","busy"};

const char *chime_enroll_phase_name(audio_enroll_phase_t phase) {
    return (unsigned)phase<sizeof(phase_names)/sizeof(phase_names[0])?phase_names[phase]:NULL;
}
const char *chime_report_reason_name(chime_report_reason_t reason) {
    return (unsigned)reason<sizeof(reason_names)/sizeof(reason_names[0])?reason_names[reason]:NULL;
}
chime_report_reason_t chime_enroll_report_reason(audio_enroll_phase_t phase, chime_reason_t reason) {
    if(phase!=AUDIO_ENROLL_FAILED) return CHIME_REPORT_NONE;
    switch(reason) {
    case CHIME_REASON_NOISY: return CHIME_REPORT_TOO_NOISY;
    case CHIME_REASON_SHORT: return CHIME_REPORT_TOO_SHORT;
    case CHIME_REASON_CLIPPED: return CHIME_REPORT_CLIPPED;
    case CHIME_REASON_NO_PCM: return CHIME_REPORT_NO_RECORDING;
    case CHIME_REASON_UNSTABLE: return CHIME_REPORT_UNSTABLE;
    case CHIME_REASON_NOISE_MATCH: return CHIME_REPORT_BACKGROUND_MATCHES;
    default: return CHIME_REPORT_NO_RECORDING;
    }
}
size_t chime_enroll_status_encode(char *out, size_t capacity, uint32_t handled_seq, audio_enroll_phase_t phase,
                                  chime_report_reason_t reason, bool registered) {
    const char *phase_name=chime_enroll_phase_name(phase);
    if(!out || !phase_name || (unsigned)reason>CHIME_REPORT_BUSY) return 0;
    /* The reason is null unless the phase is failed, and a failure always has one. */
    if((phase==AUDIO_ENROLL_FAILED)!=(reason!=CHIME_REPORT_NONE)) return 0;
    const char *reason_name=chime_report_reason_name(reason);
    int n=snprintf(out,capacity,"{\"handled_seq\":%lu,\"phase\":\"%s\",\"reason\":%s%s%s,\"registered\":%s}",
        (unsigned long)handled_seq,phase_name,reason_name?"\"":"",reason_name?reason_name:"null",reason_name?"\"":"",
        registered?"true":"false");
    return n>0 && (size_t)n<capacity?(size_t)n:0;
}
