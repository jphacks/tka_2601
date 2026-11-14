#include "chime_enroll_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Host test for the chime-enrollment wire contract: strict request parsing,
 * the phase and reason names, and the exact status body. */
static unsigned checks;
static void check(bool condition) { ++checks; assert(condition); }

static chime_enroll_parse_t parse(const char *json, chime_enroll_request_t *r)
{ return chime_enroll_parse((const uint8_t *)json,strlen(json),r); }

static void valid_requests(void)
{
    chime_enroll_request_t r={99,CHIME_ENROLL_ACTION_CANCEL};
    check(parse("{\"contract_version\":1,\"paired\":true,\"request_seq\":7,\"action\":\"start\"}",&r)==CHIME_ENROLL_PARSE_OK &&
          r.request_seq==7 && r.action==CHIME_ENROLL_ACTION_START);
    check(parse(" { \"action\" : \"cancel\" , \"request_seq\" : 12 , \"paired\" : true , \"contract_version\" : 1 } ",&r)==CHIME_ENROLL_PARSE_OK &&
          r.request_seq==12 && r.action==CHIME_ENROLL_ACTION_CANCEL);
    check(parse("{\"contract_version\":1,\"paired\":true,\"request_seq\":0,\"action\":null}",&r)==CHIME_ENROLL_PARSE_OK &&
          r.request_seq==0 && r.action==CHIME_ENROLL_ACTION_NONE);
    check(parse("{\"contract_version\":1,\"paired\":true,\"request_seq\":4294967295,\"action\":null}",&r)==CHIME_ENROLL_PARSE_OK &&
          r.request_seq==4294967295u);
    /* Unknown fields are skipped, so the contract can grow compatibly. */
    check(parse("{\"future\":{\"a\":[1,2]},\"contract_version\":1,\"paired\":true,\"request_seq\":3,\"action\":\"start\"}",&r)==CHIME_ENROLL_PARSE_OK &&
          r.request_seq==3);
}
static void unpaired_requests(void)
{
    chime_enroll_request_t r={5,CHIME_ENROLL_ACTION_START};
    check(parse("{\"contract_version\":1,\"paired\":false,\"request_seq\":0,\"action\":null}",&r)==CHIME_ENROLL_PARSE_UNPAIRED &&
          r.request_seq==0 && r.action==CHIME_ENROLL_ACTION_NONE);
    check(parse("{\"contract_version\":1,\"paired\":false,\"request_seq\":null,\"action\":null}",&r)==CHIME_ENROLL_PARSE_UNPAIRED);
    /* An unpaired device never receives an action. */
    check(parse("{\"contract_version\":1,\"paired\":false,\"request_seq\":2,\"action\":\"start\"}",&r)==CHIME_ENROLL_PARSE_INVALID);
}
static void invalid_requests(void)
{
    const char *invalid[]={
        "{\"paired\":true,\"request_seq\":1,\"action\":\"start\"}",
        "{\"contract_version\":2,\"paired\":true,\"request_seq\":1,\"action\":\"start\"}",
        "{\"contract_version\":\"1\",\"paired\":true,\"request_seq\":1,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":\"true\",\"request_seq\":1,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":\"1\",\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1.5,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":-1,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":01,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":4294967296,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":null,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":\"restart\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":\"START\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":1}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"request_seq\":2,\"action\":\"start\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":\"start\",\"action\":\"cancel\"}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":\"start\"} x",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":\"start\",}",
        "{\"contract_version\":1,\"paired\":true,\"request_seq\":1,\"action\":\"start\"",
        "[]", "null", "", "{", "{}",
    };
    for(unsigned i=0;i<sizeof(invalid)/sizeof(*invalid);++i) {
        chime_enroll_request_t r={42,CHIME_ENROLL_ACTION_CANCEL};
        check(parse(invalid[i],&r)==CHIME_ENROLL_PARSE_INVALID && r.request_seq==42 && r.action==CHIME_ENROLL_ACTION_CANCEL);
    }
    chime_enroll_request_t r;
    check(chime_enroll_parse(NULL,0,&r)==CHIME_ENROLL_PARSE_INVALID);
    check(chime_enroll_parse((const uint8_t *)"{}",2,NULL)==CHIME_ENROLL_PARSE_INVALID);
    static uint8_t huge[5000]; memset(huge,' ',sizeof(huge));
    check(chime_enroll_parse(huge,sizeof(huge),&r)==CHIME_ENROLL_PARSE_INVALID);
}
static void names_and_mapping(void)
{
    const char *phases[]={"idle","noise","listen","analyze","saving","done","failed","cancelled"};
    for(unsigned i=0;i<8;++i) check(!strcmp(chime_enroll_phase_name((audio_enroll_phase_t)i),phases[i]));
    check(chime_enroll_phase_name((audio_enroll_phase_t)8)==NULL);
    /* Same wording as the detector's own reason text, except for NONE. */
    for(unsigned r=CHIME_REASON_NOISY;r<=CHIME_REASON_NOISE_MATCH;++r) {
        chime_report_reason_t mapped=chime_enroll_report_reason(AUDIO_ENROLL_FAILED,(chime_reason_t)r);
        check(mapped!=CHIME_REPORT_NONE && !strcmp(chime_report_reason_name(mapped),chime_reason_text((chime_reason_t)r)));
    }
    /* A failure with no detector reason (call started, capture gap) is no_recording. */
    check(chime_enroll_report_reason(AUDIO_ENROLL_FAILED,CHIME_REASON_NONE)==CHIME_REPORT_NO_RECORDING);
    /* The reason is null in every other phase, even LISTEN's SHORT/CLIPPED retry hint. */
    for(unsigned p=0;p<8;++p) {
        if(p==AUDIO_ENROLL_FAILED) continue;
        check(chime_enroll_report_reason((audio_enroll_phase_t)p,CHIME_REASON_SHORT)==CHIME_REPORT_NONE);
        check(chime_enroll_report_reason((audio_enroll_phase_t)p,CHIME_REASON_CLIPPED)==CHIME_REPORT_NONE);
    }
    check(chime_report_reason_name(CHIME_REPORT_NONE)==NULL && !strcmp(chime_report_reason_name(CHIME_REPORT_BUSY),"busy"));
}
static void status_body(void)
{
    char out[128];
    check(chime_enroll_status_encode(out,sizeof(out),3,AUDIO_ENROLL_NOISE,CHIME_REPORT_NONE,false)>0);
    check(!strcmp(out,"{\"handled_seq\":3,\"phase\":\"noise\",\"reason\":null,\"registered\":false}"));
    check(chime_enroll_status_encode(out,sizeof(out),4294967295u,AUDIO_ENROLL_DONE,CHIME_REPORT_NONE,true)==
          strlen("{\"handled_seq\":4294967295,\"phase\":\"done\",\"reason\":null,\"registered\":true}"));
    check(!strcmp(out,"{\"handled_seq\":4294967295,\"phase\":\"done\",\"reason\":null,\"registered\":true}"));
    check(chime_enroll_status_encode(out,sizeof(out),9,AUDIO_ENROLL_FAILED,CHIME_REPORT_BACKGROUND_MATCHES,false)>0);
    check(!strcmp(out,"{\"handled_seq\":9,\"phase\":\"failed\",\"reason\":\"background_matches\",\"registered\":false}"));
    check(chime_enroll_status_encode(out,sizeof(out),9,AUDIO_ENROLL_FAILED,CHIME_REPORT_BUSY,true)>0);
    check(!strcmp(out,"{\"handled_seq\":9,\"phase\":\"failed\",\"reason\":\"busy\",\"registered\":true}"));
    /* Every phase encodes; the contract's rule "reason only with failed" is enforced both ways. */
    for(unsigned p=0;p<8;++p) {
        bool failed=p==AUDIO_ENROLL_FAILED;
        check(chime_enroll_status_encode(out,sizeof(out),1,(audio_enroll_phase_t)p,failed?CHIME_REPORT_TOO_NOISY:CHIME_REPORT_NONE,false)>0);
        check(chime_enroll_status_encode(out,sizeof(out),1,(audio_enroll_phase_t)p,failed?CHIME_REPORT_NONE:CHIME_REPORT_TOO_NOISY,false)==0);
    }
    check(chime_enroll_status_encode(out,10,1,AUDIO_ENROLL_IDLE,CHIME_REPORT_NONE,false)==0);
    check(chime_enroll_status_encode(out,sizeof(out),1,(audio_enroll_phase_t)8,CHIME_REPORT_NONE,false)==0);
    check(chime_enroll_status_encode(out,sizeof(out),1,AUDIO_ENROLL_FAILED,(chime_report_reason_t)8,false)==0);
    check(chime_enroll_status_encode(NULL,0,1,AUDIO_ENROLL_IDLE,CHIME_REPORT_NONE,false)==0);
}
int main(void)
{
    valid_requests();
    unpaired_requests();
    invalid_requests();
    names_and_mapping();
    status_body();
    printf("chime enroll protocol: %u checks passed\n",checks);
    return 0;
}
