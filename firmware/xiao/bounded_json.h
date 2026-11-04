#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <limits.h>
#include <string.h>

/* Small bounded JSON reader: no heap and no dependency on SDK JSON parsers.
 * Unknown fields are fully validated and skipped, never interpreted as commands.
 * Known fields reject duplicates, wrong types, overflow, and noninteger numbers. */
typedef struct { const uint8_t *p, *end; unsigned nodes, node_limit, depth_limit; } json_t;
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
    space(j); if(j->p==j->end || ++j->nodes>(j->node_limit?j->node_limit:96) || depth>(j->depth_limit?j->depth_limit:4)) return false;
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
