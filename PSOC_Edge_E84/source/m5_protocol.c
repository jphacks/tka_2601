#include "m5_protocol.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

static bool token_valid(const char *token)
{
    if (!token || strlen(token) != 64u) return false;
    for (unsigned i = 0; i < 64u; ++i)
        if (!((token[i] >= '0' && token[i] <= '9') ||
              (token[i] >= 'a' && token[i] <= 'f'))) return false;
    return true;
}

size_t m5_message_format(char *output, size_t capacity, const uint32_t id[4],
                         float score, const char *token)
{
    if (!output || !capacity || !id || !token_valid(token) ||
        !isfinite(score) || (score < 0.0f && score != -1.0f)) return 0;
    int length = snprintf(output, capacity,
        "{\"v\":1,\"type\":\"chime\",\"event_id\":\"%08lx%08lx%08lx%08lx\","
        "\"score\":%.5f,\"token\":\"%s\"}",
        (unsigned long)id[0], (unsigned long)id[1],
        (unsigned long)id[2], (unsigned long)id[3], (double)score, token);
    if (length <= 0 || (size_t)length >= capacity) {
        output[0] = '\0';
        return 0;
    }
    return (size_t)length;
}

size_t m5_probe_format(char *output, size_t capacity, const uint32_t id[4],
                       const char *token, bool reply)
{
    if (!output || !capacity || !id || !token_valid(token)) return 0;
    int length = snprintf(output, capacity,
        "{\"v\":1,\"type\":\"%s\",\"event_id\":\"%08lx%08lx%08lx%08lx\",\"token\":\"%s\"}",
        reply ? "pong" : "ping", (unsigned long)id[0], (unsigned long)id[1],
        (unsigned long)id[2], (unsigned long)id[3], token);
    if (length <= 0 || (size_t)length >= capacity) {
        output[0] = '\0';
        return 0;
    }
    return (size_t)length;
}

bool m5_probe_reply_matches(const char *packet, size_t length,
                            const uint32_t id[4], const char *token)
{
    char expected[192];
    size_t expected_length = m5_probe_format(expected, sizeof(expected), id, token, true);
    if (!packet || !expected_length || length != expected_length) return false;
    unsigned difference = 0;
    for (size_t i = 0; i < length; ++i)
        difference |= (unsigned char)packet[i] ^ (unsigned char)expected[i];
    return difference == 0;
}
