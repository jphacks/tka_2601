#include "pusher_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static pusher_settings_result_t parse(const char *text, servo_pusher_config_t *out) {
    return pusher_settings_parse((const uint8_t *)text,strlen(text),out);
}
int main(void) {
    servo_pusher_config_t out={0};
    const char *valid="{\"contract_version\":1,\"paired\":true,\"shop\":{\"name\":\"日本語店舗\"},\"pusher_settings\":{"
        "\"desired_revision\":7,\"desired_config\":{\"schema_version\":1,\"enabled_pushers\":[\"p2\"],"
        "\"assignments\":{\"call_start\":\"p2\",\"call_end\":\"p2\"}},\"applied_revision\":2}}";
    assert(parse(valid,&out)==PUSHER_SETTINGS_CONFIG);
    assert(out.revision==7 && out.schema_version==1 && out.enabled_mask==2 && out.call_start==2 && out.call_end==2);
    const char *swapped="{\"paired\":true,\"pusher_settings\":{\"desired_revision\":4294967295,\"desired_config\":{"
        "\"schema_version\":1,\"enabled_pushers\":[\"p2\",\"p1\"],\"assignments\":{\"call_end\":\"p1\",\"call_start\":\"p2\"}}}}";
    assert(parse(swapped,&out)==PUSHER_SETTINGS_CONFIG && out.revision==UINT32_MAX && out.enabled_mask==3);
    const char *bad[]={
        "{}", "{\"paired\":true,\"paired\":false}", "{\"paired\":true,\"pusher_settings\":{}}",
        "{\"paired\":true,\"pusher_settings\":{\"desired_revision\":1,\"desired_config\":null}}",
        "{\"paired\":true,\"pusher_settings\":{\"desired_revision\":01,\"desired_config\":null}}",
        "{\"paired\":true,\"pusher_settings\":{\"desired_revision\":4294967296,\"desired_config\":null}}",
        "{\"paired\":true,\"pusher_settings\":null}garbage", "{\"paired\":true,\"x\":\"bad\\uD800\"}",
        "{\"paired\":true,\"x\":[1,]}", "{\"paired\":true,\"x\":{\"a\":1,}}"
    };
    for(size_t i=0;i<sizeof(bad)/sizeof(bad[0]);++i) assert(parse(bad[i],&out)==PUSHER_SETTINGS_INVALID);
    assert(parse("{\"paired\":false}",&out)==PUSHER_SETTINGS_UNPAIRED);
    assert(parse("{\"paired\":true}",&out)==PUSHER_SETTINGS_MISSING);
    assert(parse("{\"paired\":true,\"pusher_settings\":null}",&out)==PUSHER_SETTINGS_LOCAL);
    assert(parse("{\"paired\":true,\"pusher_settings\":{\"desired_revision\":0,\"desired_config\":null}}",&out)==PUSHER_SETTINGS_LOCAL);
    char mutated[1024];
    const char *find[]={"[\"p2\"]", "\"call_end\":\"p2\"", "\"schema_version\":1", "\"desired_revision\":7"};
    const char *replace[]={"[\"p2\",\"p2\"]", "\"call_end\":\"p3\"", "\"schema_version\":65536", "\"desired_revision\":-1"};
    for(unsigned i=0;i<4;++i) {
        const char *at=strstr(valid,find[i]); assert(at);
        snprintf(mutated,sizeof(mutated),"%.*s%s%s",(int)(at-valid),valid,replace[i],at+strlen(find[i]));
        assert(parse(mutated,&out)==PUSHER_SETTINGS_INVALID);
    }
    assert(parse(valid,&out)==PUSHER_SETTINGS_CONFIG);
    char report[768];
    size_t size=pusher_status_encode(report,sizeof(report),&out,"servo_busy",true,7,8);
    assert(size && size==strlen(report));
    assert(strstr(report,"\"applied_revision\":7") && strstr(report,"manual_check_required") && strstr(report,"\"gpio\":8"));
    assert(pusher_status_encode(report,8,&out,NULL,false,7,8)==0);
    assert(pusher_status_encode(report,sizeof(report),&out,"injected\"error",false,7,8)==0);
    assert(pusher_status_encode(report,sizeof(report),NULL,"storage_failed",true,7,8)>0);
    assert(strstr(report,"\"applied_revision\":null") && strstr(report,"\"applied_config\":null"));
    assert(strstr(report,"manual_check_required") && strstr(report,"storage_failed"));
    for(size_t n=0;n<strlen(valid);++n) assert(pusher_settings_parse((const uint8_t *)valid,n,&out)==PUSHER_SETTINGS_INVALID);
    puts("PASS: bounded pusher JSON validation, shared/swapped routing and actual status encoding");
}
