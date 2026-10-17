#include "voice_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    uint8_t bytes[VOICE_PACKET];
    voice_header_t h={.type=VOICE_INPUT_AUDIO,.session=0x12345678,.turn=9,.sequence=1499,.length=640}, out;
    assert(voice_header_encode(bytes,&h));
    assert(!memcmp(bytes,"DVS1\x06\0\0\0\x12\x34\x56\x78",12));
    assert(voice_header_decode(bytes,&out));
    assert(out.length==640 && out.sequence==1499 && out.session==h.session && out.turn==9);
    bytes[6]=1; assert(!voice_header_decode(bytes,&out)); bytes[6]=0;
    bytes[5]=1; assert(!voice_header_decode(bytes,&out)); bytes[5]=0;
    h.length=639; assert(!voice_header_encode(bytes,&h));
    h.length=642; assert(!voice_header_encode(bytes,&h));
    h.length=0; assert(!voice_header_encode(bytes,&h));
    h.length=640; h.session=0; assert(!voice_header_encode(bytes,&h));
    h=(voice_header_t){.type=VOICE_INPUT_END,.flags=1,.session=1,.sequence=1500};
    assert(voice_header_encode(bytes,&h)); assert(voice_header_decode(bytes,&out));
    h.flags=2; assert(!voice_header_encode(bytes,&h));
    for (unsigned type=VOICE_HELLO;type<=VOICE_AUDIO_ACK;++type) {
        h=(voice_header_t){.type=(uint8_t)type,.session=1};
        if (type==VOICE_INPUT_AUDIO || type==VOICE_OUTPUT_AUDIO) h.length=640;
        assert(voice_header_encode(bytes,&h)); assert(voice_header_decode(bytes,&out));
    }
    uint8_t op; bool final; size_t n;
    const uint8_t ws[]={0x82,126,2,152};
    assert(voice_ws_header(ws,1,&op,&final,&n)==0);
    assert(voice_ws_header(ws,2,&op,&final,&n)==0);
    assert(voice_ws_header(ws,4,&op,&final,&n)==4 && op==2 && final && n==664);
    const uint8_t ping[]={0x89,0};
    assert(voice_ws_header(ping,2,&op,&final,&n)==2 && op==9 && n==0);
    const uint8_t continuation[]={0x80,0};
    assert(voice_ws_header(continuation,2,&op,&final,&n)==2 && op==0);
    const uint8_t text[]={0x81,2};
    assert(voice_ws_header(text,2,&op,&final,&n)==2 && op==1 && n==2);
    const uint8_t invalid[][4]={{0xc2,0,0,0},{0x82,0x80,0,0},
        {0x89,126,0,126},{0x09,0,0,0},{0x82,127,0,0},{0x82,126,0,1},
        {0x82,126,0xff,0xff},{0x88,1,0,0},{0x83,0,0,0}};
    for (unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);++i)
        assert(voice_ws_header(invalid[i],4,&op,&final,&n)==-1);
    const char *accept="s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
    const char *reply="HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
        "Connection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
    assert(voice_ws_upgrade_valid(reply,accept));
    assert(!voice_ws_upgrade_valid(reply,"wrong"));
    assert(!voice_ws_upgrade_valid("HTTP/1.1 200 OK\r\n\r\n",accept));
    assert(!voice_ws_upgrade_valid("HTTP/1.1 101 OK\r\n\r\n",accept));
    assert(!voice_ws_upgrade_valid("HTTP/1.1 101 OK\r\nUpgrade: websocket\r\n"
        "Connection: upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
        "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n",accept));
    /* Every possible one-byte value in each header position must remain bounded. */
    for (size_t i=0;i<VOICE_HEADER;++i) for (unsigned value=0;value<256;++value) {
        h=(voice_header_t){.type=VOICE_OUTPUT_AUDIO,.session=42,.length=640};
        assert(voice_header_encode(bytes,&h)); bytes[i]=(uint8_t)value;
        (void)voice_header_decode(bytes,&out);
    }
    puts("voice protocol / WebSocket validation passed");
}
