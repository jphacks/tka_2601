#include "relay_protocol.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>

/* Small bounded JSON reader: no heap and no dependency on SDK JSON parsers.
 * Unknown fields are fully validated and skipped, never interpreted as commands.
 * Known fields reject duplicates, wrong types, overflow, and noninteger numbers. */
typedef struct { const uint8_t *p, *end; unsigned nodes; } json_t;
static void space(json_t *j)
{ while(j->p<j->end && (*j->p==' ' || *j->p=='\t' || *j->p=='\r' || *j->p=='\n')) ++j->p; }
static int hex(uint8_t c)
{ return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1; }
static bool string(json_t *j, char *out, size_t capacity)
{
    if(j->p==j->end || *j->p++!='"') return false;
    size_t used=0;
    while(j->p<j->end) {
        unsigned c=*j->p++;
        if(c=='"') { if(out) out[used<capacity?used:capacity-1]=0; return !out || used<capacity; }
        if(c<32) return false;
        if(c=='\\') {
            if(j->p==j->end) return false;
            c=*j->p++;
            if(c=='u') {
                if((size_t)(j->end-j->p)<4) return false;
                c=0;
                for(unsigned i=0;i<4;++i) { int h=hex(*j->p++); if(h<0) return false; c=c*16+(unsigned)h; }
                if(c>=0xd800 && c<=0xdbff) {
                    if((size_t)(j->end-j->p)<6 || j->p[0]!='\\' || j->p[1]!='u') return false;
                    j->p+=2; unsigned low=0;
                    for(unsigned i=0;i<4;++i) { int h=hex(*j->p++); if(h<0) return false; low=low*16+(unsigned)h; }
                    if(low<0xdc00 || low>0xdfff) return false;
                    c=0x10000;
                } else if(c>=0xdc00 && c<=0xdfff) return false;
                if(!c) return false;
                if(c>127) c=255; /* protocol identifiers are ASCII */
            } else {
                const char *esc="\"\\/bfnrt";
                if(!strchr(esc,(int)c)) return false;
                if(c=='b'||c=='f'||c=='n'||c=='r'||c=='t') c=255;
            }
        } else if(c>=128) {
            /* Validate UTF-8 even for ignored transcript text. */
            unsigned more, value, minimum;
            if(c>=0xc2 && c<=0xdf) { more=1; value=c&31; minimum=0x80; }
            else if(c>=0xe0 && c<=0xef) { more=2; value=c&15; minimum=0x800; }
            else if(c>=0xf0 && c<=0xf4) { more=3; value=c&7; minimum=0x10000; }
            else return false;
            while(more--) { if(j->p==j->end || (*j->p&0xc0)!=0x80) return false; value=(value<<6)|(*j->p++&63); }
            if(value<minimum || value>0x10ffff || (value>=0xd800 && value<=0xdfff)) return false;
            c=255;
        }
        if(out && used+1<capacity) out[used]=(char)c;
        ++used;
    }
    return false;
}
static bool literal(json_t *j, const char *word)
{
    size_t n=strlen(word);
    if((size_t)(j->end-j->p)<n || memcmp(j->p,word,n)) return false;
    j->p+=n; return true;
}
static bool number(json_t *j)
{
    if(j->p<j->end && *j->p=='-') ++j->p;
    if(j->p==j->end) return false;
    if(*j->p=='0') ++j->p;
    else { if(*j->p<'1'||*j->p>'9') return false; do { ++j->p; } while(j->p<j->end && *j->p>='0'&&*j->p<='9'); }
    if(j->p<j->end && *j->p=='.') {
        ++j->p; const uint8_t *start=j->p;
        while(j->p<j->end && *j->p>='0'&&*j->p<='9') ++j->p;
        if(start==j->p) return false;
    }
    if(j->p<j->end && (*j->p=='e'||*j->p=='E')) {
        ++j->p; if(j->p<j->end && (*j->p=='+'||*j->p=='-')) ++j->p;
        const uint8_t *start=j->p;
        while(j->p<j->end && *j->p>='0'&&*j->p<='9') ++j->p;
        if(start==j->p) return false;
    }
    return true;
}
static bool skip(json_t *j, unsigned depth)
{
    space(j); if(j->p==j->end || ++j->nodes>96 || depth>4) return false;
    uint8_t c=*j->p;
    if(c=='"') return string(j,NULL,0);
    if(c=='t') return literal(j,"true");
    if(c=='f') return literal(j,"false");
    if(c=='n') return literal(j,"null");
    if(c!='{' && c!='[') return number(j);
    ++j->p; space(j); uint8_t end=c=='{'?'}':']';
    if(j->p<j->end && *j->p==end) { ++j->p; return true; }
    for(;;) {
        if(c=='{') { if(!string(j,NULL,0)) return false; space(j); if(j->p==j->end||*j->p++!=':') return false; }
        if(!skip(j,depth+1)) return false;
        space(j); if(j->p==j->end) return false;
        if(*j->p==end) { ++j->p; return true; }
        if(*j->p++!=',') return false;
        space(j);
    }
}
static bool integer(json_t *j, uint32_t *out)
{
    if(j->p==j->end || *j->p<'0' || *j->p>'9') return false;
    uint32_t n=0; bool leading_zero=*j->p=='0'; unsigned digits=0;
    while(j->p<j->end && *j->p>='0' && *j->p<='9') {
        unsigned digit=*j->p++-'0';
        if(n>(UINT32_MAX-digit)/10 || (leading_zero && digits)) return false;
        n=n*10+digit; ++digits;
    }
    *out=n; return true;
}
enum { F_TYPE=1, F_VERSION=2, F_TURN=4, F_OUTPUT=8, F_FRAMES=16, F_SAMPLES=32, F_END=64, F_SEQ=128 };
typedef struct {
    char type[32]; unsigned fields;
    uint32_t version, turn, output, frames, samples, seq; bool end;
} fields_t;
static bool fields(const uint8_t *wire, size_t n, fields_t *f)
{
    json_t j={.p=wire,.end=wire+n}; memset(f,0,sizeof(*f)); space(&j);
    if(j.p==j.end || *j.p++!='{') return false;
    space(&j); if(j.p==j.end || *j.p=='}') return false;
    for(unsigned count=0;count<32;++count) {
        char key[64]; if(!string(&j,key,sizeof(key))) return false;
        space(&j); if(j.p==j.end || *j.p++!=':') return false; space(&j);
        unsigned bit=0; uint32_t *value=NULL;
        if(!strcmp(key,"type")) bit=F_TYPE;
        else if(!strcmp(key,"protocol_version")) { bit=F_VERSION; value=&f->version; }
        else if(!strcmp(key,"turn_id")) { bit=F_TURN; value=&f->turn; }
        else if(!strcmp(key,"output_id")) { bit=F_OUTPUT; value=&f->output; }
        else if(!strcmp(key,"frames")) { bit=F_FRAMES; value=&f->frames; }
        else if(!strcmp(key,"samples")) { bit=F_SAMPLES; value=&f->samples; }
        else if(!strcmp(key,"seq")) { bit=F_SEQ; value=&f->seq; }
        else if(!strcmp(key,"end_call")) bit=F_END;
        if(bit && (f->fields&bit)) return false;
        f->fields|=bit;
        if(value) { if(!integer(&j,value)) return false; }
        else if(bit==F_TYPE) { if(!string(&j,f->type,sizeof(f->type))) return false; }
        else if(bit==F_END) { if(literal(&j,"true")) f->end=true; else if(!literal(&j,"false")) return false; }
        else if(!skip(&j,0)) return false;
        space(&j); if(j.p==j.end) return false;
        if(*j.p=='}') { ++j.p; space(&j); return j.p==j.end && (f->fields&F_TYPE); }
        if(*j.p++!=',') return false;
        space(&j);
    }
    return false;
}
bool voice_relay_settings_valid(const char *mode, const char *key)
{
    if(!mode || (strcmp(mode,"normal") && strcmp(mode,"omakase") && strcmp(mode,"away")) || !key) return false;
    size_t n=strlen(key); if(!n || n>512) return false;
    for(size_t i=0;i<n;++i) if((unsigned char)key[i]<33 || (unsigned char)key[i]>126) return false;
    return true;
}
static bool escape(const char *s, char *out, size_t cap)
{
    size_t n=0;
    for(;*s;++s) {
        if((*s=='"'||*s=='\\')) { if(n+1>=cap) return false; out[n++]='\\'; }
        if(n+1>=cap) return false;
        out[n++]=*s;
    }
    out[n]=0; return true;
}
bool voice_relay_encode(voice_relay_t *r, const voice_header_t *h,
    const void *payload, const char *uuid, const char *mode, const char *key,
    uint8_t *wire, size_t capacity, size_t *length, uint8_t *opcode)
{
    uint8_t checked[VOICE_HEADER];
    if(!voice_header_encode(checked,h) || (h->length && !payload)) return false;
    *opcode=1; int n=-1;
    if(h->type==VOICE_HELLO) {
        if(r->started || h->turn || h->length || !uuid || strlen(uuid)!=36 || !voice_relay_settings_valid(mode,key)) return false;
        char escaped[1025]; if(!escape(key,escaped,sizeof(escaped))) return false;
        n=snprintf((char *)wire,capacity,"{\"type\":\"start\",\"protocol_version\":2,\"visit_id\":\"%s\",\"mode\":\"%s\",\"device_key\":\"%s\"}",uuid,mode,escaped);
        if(n<0 || (size_t)n>=capacity) return false;
        r->session=h->session; r->started=true;
    } else {
        if(!r->started || h->session!=r->session || (!r->ready && h->type!=VOICE_CANCEL && h->type!=VOICE_PONG)) return false;
        switch(h->type) {
        case VOICE_CALL_START:
            if(h->turn) return false;
            n=snprintf((char *)wire,capacity,"{\"type\":\"call_started\",\"turn_id\":0}"); break;
        case VOICE_INPUT_START:
            if(r->input_active || r->output_active || !h->turn) return false;
            r->input_active=true; r->input_turn=h->turn; r->input_frames=0;
            n=snprintf((char *)wire,capacity,"{\"type\":\"input_start\",\"turn_id\":%lu}",(unsigned long)h->turn); break;
        case VOICE_INPUT_AUDIO:
            if(!r->input_active || h->turn!=r->input_turn || h->sequence!=r->input_frames || r->input_frames>=1500 || h->length!=640 || capacity<640) return false;
            memcpy(wire,payload,640); *length=640; *opcode=2; ++r->input_frames; return true;
        case VOICE_INPUT_END:
            if(!r->input_active || h->turn!=r->input_turn || !r->input_frames || h->sequence!=r->input_frames || (h->flags==1 && r->input_frames!=1500)) return false;
            r->input_active=false;
            n=snprintf((char *)wire,capacity,"{\"type\":\"input_end\",\"turn_id\":%lu,\"frames\":%lu,\"samples\":%lu,\"reason\":\"%s\"}",
                (unsigned long)h->turn,(unsigned long)h->sequence,(unsigned long)(h->sequence*320),h->flags?"max_duration":"silence"); break;
        case VOICE_AUDIO_ACK:
        case VOICE_PLAYBACK_DONE:
            if(h->turn!=r->output_turn || !h->sequence || h->sequence>r->output_frames ||
                (h->type==VOICE_PLAYBACK_DONE && (!r->output_complete || h->sequence!=r->output_frames))) return false;
            if(h->type==VOICE_AUDIO_ACK)
                n=snprintf((char *)wire,capacity,"{\"type\":\"audio_ack\",\"turn_id\":%lu,\"output_id\":%lu,\"frames\":%lu}",
                    (unsigned long)h->turn,(unsigned long)h->turn,(unsigned long)h->sequence);
            else n=snprintf((char *)wire,capacity,"{\"type\":\"playback_done\",\"turn_id\":%lu,\"output_id\":%lu,\"frames\":%lu,\"samples\":%lu}",
                    (unsigned long)h->turn,(unsigned long)h->turn,(unsigned long)h->sequence,(unsigned long)r->output_samples);
            break;
        case VOICE_CALL_ENDED:
            n=snprintf((char *)wire,capacity,"{\"type\":\"call_ended\",\"turn_id\":%lu}",(unsigned long)h->turn); break;
        case VOICE_CANCEL:
            n=snprintf((char *)wire,capacity,"{\"type\":\"cancel\",\"turn_id\":%lu}",(unsigned long)h->turn); break;
        case VOICE_PING:
        case VOICE_PONG:
            n=snprintf((char *)wire,capacity,"{\"type\":\"%s\",\"turn_id\":%lu,\"seq\":%lu}",h->type==VOICE_PING?"ping":"pong",(unsigned long)h->turn,(unsigned long)h->sequence); break;
        default: return false;
        }
    }
    if(n<0 || (size_t)n>=capacity) return false;
    *length=(size_t)n; return true;
}
int voice_relay_decode(voice_relay_t *r, uint8_t opcode,
    const uint8_t *wire, size_t length, voice_header_t *h, uint8_t *payload)
{
    if(!r->started || length>VOICE_PACKET) return -1;
    memset(h,0,sizeof(*h)); h->session=r->session;
    if(opcode==2) {
        if(!r->ready || !r->output_active || length<2 || length>640 || (length&1) || r->output_frames>=3000) return -1;
        h->type=VOICE_OUTPUT_AUDIO; h->turn=r->output_turn; h->sequence=r->output_frames++; h->length=(uint32_t)length;
        r->output_samples+=(uint32_t)(length/2); memcpy(payload,wire,length); return 1;
    }
    fields_t f;
    if(opcode!=1 || !fields(wire,length,&f)) return -1;
    if(!strcmp(f.type,"ready")) {
        if(r->ready || !(f.fields&F_VERSION) || f.version!=2) return -1;
        r->ready=true; h->type=VOICE_READY; return 1;
    }
    if(!strcmp(f.type,"error")) { h->type=VOICE_ERROR; return 1; }
    if(!r->ready) return -1;
    if(!strcmp(f.type,"transcript") || !strcmp(f.type,"agent_state")) return 0;
    if(!(f.fields&F_TURN)) return -1;
    h->turn=f.turn;
    if(!strcmp(f.type,"output_start")) {
        if(r->output_active || r->input_active || !(f.fields&F_OUTPUT) || f.output!=f.turn) return -1;
        r->output_active=true; r->output_complete=false;
        r->output_turn=f.turn; r->output_frames=r->output_samples=0; h->type=VOICE_OUTPUT_START;
    } else if(!strcmp(f.type,"output_end")) {
        unsigned needed=F_OUTPUT|F_FRAMES|F_SAMPLES|F_END;
        if(!r->output_active || (f.fields&needed)!=needed || f.turn!=r->output_turn || f.output!=f.turn ||
            !r->output_frames || f.frames!=r->output_frames || f.samples!=r->output_samples) return -1;
        r->output_active=false; r->output_complete=true;
        h->type=VOICE_OUTPUT_END; h->sequence=f.frames; h->flags=f.end?1:0;
    } else if(!strcmp(f.type,"listen")) { h->type=VOICE_LISTEN; }
    else if(!strcmp(f.type,"no_reply")) { h->type=VOICE_NO_REPLY; }
    else if(!strcmp(f.type,"call_end")) { h->type=VOICE_CALL_END; }
    else if(!strcmp(f.type,"ping") || !strcmp(f.type,"pong")) {
        if(!(f.fields&F_SEQ)) return -1;
        h->type=!strcmp(f.type,"ping")?VOICE_PING:VOICE_PONG; h->sequence=f.seq;
    } else return -1;
    return 1;
}
