#include "device_http.h"
#include "api_settings.h"
#include "net_stream.h"
#include <stdio.h>
#include <stdlib.h>

#if __has_include("device_config.h")
#include "device_config.h"
#endif
#ifndef DEVICE_SETTINGS_HOST
#define DEVICE_SETTINGS_HOST ""
#endif
#ifndef DEVICE_SETTINGS_API_KEY
#define DEVICE_SETTINGS_API_KEY ""
#endif
#ifndef DEVICE_SETTINGS_CA_PEM
#define DEVICE_SETTINGS_CA_PEM ""
#endif

bool device_http_configured(void) {
    size_t host=strlen(DEVICE_SETTINGS_HOST), api=strlen(DEVICE_SETTINGS_API_KEY), key=strlen(DOOR_DEVICE_KEY);
    if(!host || host>127 || !api || api>511 || !key || key>511 || !DEVICE_SETTINGS_CA_PEM[0]) return false;
    for(const char *p=DEVICE_SETTINGS_HOST;*p;++p)
        if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='.'||*p=='-')) return false;
    for(const char *p=DEVICE_SETTINGS_API_KEY;*p;++p) if(*p<33 || *p>126) return false;
    for(const char *p=DOOR_DEVICE_KEY;*p;++p) if(*p<33 || *p>126) return false;
    return true;
}
response_t *device_http_request(const char *method, const char *path, const char *body, size_t bytes) {
    response_t *response=calloc(1,sizeof(*response)); if(!response) return NULL;
    net_stream_t *stream=net_stream_open(DEVICE_SETTINGS_HOST,443,DEVICE_SETTINGS_CA_PEM);
    if(!stream) { free(response); return NULL; }
    char headers[1536];
    int length=snprintf(headers,sizeof(headers),"%s %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\napikey: %s\r\n"
        "Accept: application/json\r\nContent-Type: application/json\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        method,path,DEVICE_SETTINGS_HOST,DOOR_DEVICE_KEY,DEVICE_SETTINGS_API_KEY,(unsigned long)bytes);
    bool ok=length>0 && (size_t)length<sizeof(headers);
    uint32_t start=net_now_ms();
    for(unsigned segment=0;segment<2 && ok;++segment) {
        const uint8_t *data=(const uint8_t *)(segment?body:headers);
        size_t remaining=segment?bytes:(size_t)length;
        while(remaining) {
            int sent=net_stream_write(stream,data,remaining);
            if(sent<0 || (size_t)sent>remaining || net_now_ms()-start>=10000u) { ok=false; break; }
            data+=sent; remaining-=sent; if(!sent) net_sleep_ms(2);
        }
    }
    memset(headers,0,sizeof(headers));
    bool complete=false;
    while(ok && net_now_ms()-start<10000u && response->used<WIRE_LIMIT) {
        int got=net_stream_read(stream,response->wire+response->used,WIRE_LIMIT-response->used);
        if(got>0) response->used+=(size_t)got;
        response_state_t state=parse_response(response,got<0);
        if(state==RESPONSE_COMPLETE) { complete=true; break; }
        if(state==RESPONSE_INVALID || got<0) break;
        if(!got) net_sleep_ms(2);
    }
    net_stream_close(stream);
    if(!complete) { free(response); return NULL; }
    return response;
}
uint32_t device_http_retry_interval(uint32_t interval) {
    if(interval<5000u) interval=5000u;
    return interval<30000u?interval*2u:60000u;
}
