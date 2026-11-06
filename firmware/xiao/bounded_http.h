#pragma once
/* Shared bounded HTTP/1.1 decoder. Existing door-server behavior is retained. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define HEADER_LIMIT 4096u
#define WIRE_LIMIT 8192u
#define BODY_LIMIT 4096u

typedef enum { RESPONSE_MORE, RESPONSE_COMPLETE, RESPONSE_INVALID } response_state_t;
typedef struct
{
    char wire[WIRE_LIMIT];
    char body[BODY_LIMIT + 1u];
    size_t used;
    size_t body_length;
    unsigned status;
} response_t;

static size_t line_end(const char *data, size_t start, size_t length)
{
    for (size_t i = start; i + 1u < length; ++i)
        if (data[i] == '\r' && data[i + 1u] == '\n')
            return i;
    return SIZE_MAX;
}

static bool equal_ci(const char *text, size_t length, const char *expected)
{
    if (length != strlen(expected))
        return false;
    for (size_t i = 0; i < length; ++i)
    {
        unsigned char c = (unsigned char)text[i];
        if (c >= 'A' && c <= 'Z')
            c = (unsigned char)(c + ('a' - 'A'));
        if (c != (unsigned char)expected[i])
            return false;
    }
    return true;
}

static bool header_name_char(unsigned char c)
{
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
           (c >= 'a' && c <= 'z') ||
           (c != 0 && strchr("!#$%&'*+-.^_`|~", c) != NULL);
}

static bool decimal_length(const char *text, size_t length, size_t *value)
{
    size_t n = 0;
    if (length == 0)
        return false;
    for (size_t i = 0; i < length; ++i)
    {
        if (text[i] < '0' || text[i] > '9')
            return false;
        unsigned digit = (unsigned)(text[i] - '0');
        if (n > (BODY_LIMIT - digit) / 10u)
            return false;
        n = n * 10u + digit;
    }
    *value = n;
    return true;
}

static response_state_t chunked_body(response_t *response, size_t position, bool eof)
{
    size_t output = 0;
    for (;;)
    {
        size_t end = line_end(response->wire, position, response->used);
        if (end == SIZE_MAX)
            return eof || response->used - position > 128u ? RESPONSE_INVALID : RESPONSE_MORE;
        if (end == position || end - position > 128u)
            return RESPONSE_INVALID;
        size_t chunk = 0;
        size_t i = position;
        for (; i < end && response->wire[i] != ';'; ++i)
        {
            unsigned char c = (unsigned char)response->wire[i];
            unsigned digit;
            if (c >= '0' && c <= '9') digit = c - '0';
            else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10u;
            else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10u;
            else return RESPONSE_INVALID;
            if (chunk > (BODY_LIMIT - digit) / 16u)
                return RESPONSE_INVALID;
            chunk = chunk * 16u + digit;
        }
        if (i == position)
            return RESPONSE_INVALID;
        /* Extensions are ignored, but control characters are not accepted. */
        for (; i < end; ++i)
            if ((unsigned char)response->wire[i] < 0x20u || response->wire[i] == 0x7f)
                return RESPONSE_INVALID;
        position = end + 2u;
        if (chunk == 0)
        {
            for (;;)
            {
                end = line_end(response->wire, position, response->used);
                if (end == SIZE_MAX)
                    return eof ? RESPONSE_INVALID : RESPONSE_MORE;
                if (end == position)
                {
                    response->body_length = output;
                    response->body[output] = '\0';
                    return RESPONSE_COMPLETE;
                }
                /* Trailer fields do not affect this response's framing. */
                size_t colon = position;
                while (colon < end && header_name_char((unsigned char)response->wire[colon]))
                    ++colon;
                if (colon == position || colon == end || response->wire[colon] != ':')
                    return RESPONSE_INVALID;
                for (i = colon + 1u; i < end; ++i)
                    if (((unsigned char)response->wire[i] < 0x20u && response->wire[i] != '\t') ||
                        response->wire[i] == 0x7f)
                        return RESPONSE_INVALID;
                position = end + 2u;
            }
        }
        if (chunk > BODY_LIMIT - output)
            return RESPONSE_INVALID;
        if (response->used - position < chunk + 2u)
            return eof ? RESPONSE_INVALID : RESPONSE_MORE;
        if (response->wire[position + chunk] != '\r' ||
            response->wire[position + chunk + 1u] != '\n')
            return RESPONSE_INVALID;
        memcpy(response->body + output, response->wire + position, chunk);
        output += chunk;
        position += chunk + 2u;
    }
}

/* Parse only bounded bytes; incomplete TCP fragments are not protocol errors. */
static inline response_state_t parse_response(response_t *response, bool eof)
{
    size_t end = line_end(response->wire, 0, response->used);
    if (end == SIZE_MAX)
        return eof || response->used >= HEADER_LIMIT ? RESPONSE_INVALID : RESPONSE_MORE;
    if (end < 13u || end > 128u ||
        (memcmp(response->wire, "HTTP/1.1 ", 9u) != 0 &&
         memcmp(response->wire, "HTTP/1.0 ", 9u) != 0) ||
        response->wire[9] < '1' || response->wire[9] > '5' ||
        response->wire[10] < '0' || response->wire[10] > '9' ||
        response->wire[11] < '0' || response->wire[11] > '9' || response->wire[12] != ' ')
        return RESPONSE_INVALID;
    response->status = (unsigned)(response->wire[9] - '0') * 100u +
                       (unsigned)(response->wire[10] - '0') * 10u +
                       (unsigned)(response->wire[11] - '0');
    /* These GET requests do not negotiate informational or upgrade responses. */
    if (response->status < 200u)
        return RESPONSE_INVALID;
    size_t position = end + 2u;
    size_t content_length = 0;
    bool has_length = false;
    bool chunked = false;
    for (;;)
    {
        end = line_end(response->wire, position, response->used);
        if (end == SIZE_MAX)
            return eof || response->used >= HEADER_LIMIT ? RESPONSE_INVALID : RESPONSE_MORE;
        if (end + 2u > HEADER_LIMIT)
            return RESPONSE_INVALID;
        if (end == position)
        {
            position = end + 2u;
            break;
        }
        size_t colon = position;
        while (colon < end && header_name_char((unsigned char)response->wire[colon]))
            ++colon;
        if (colon == position || colon == end || response->wire[colon] != ':')
            return RESPONSE_INVALID;
        size_t value = colon + 1u;
        size_t value_end = end;
        for (size_t i = value; i < end; ++i)
            if (((unsigned char)response->wire[i] < 0x20u && response->wire[i] != '\t') ||
                response->wire[i] == 0x7f)
                return RESPONSE_INVALID;
        while (value < value_end && (response->wire[value] == ' ' || response->wire[value] == '\t')) ++value;
        while (value_end > value && (response->wire[value_end - 1u] == ' ' || response->wire[value_end - 1u] == '\t')) --value_end;
        if (equal_ci(response->wire + position, colon - position, "content-length"))
        {
            size_t parsed;
            if (!decimal_length(response->wire + value, value_end - value, &parsed) ||
                (has_length && parsed != content_length))
                return RESPONSE_INVALID;
            content_length = parsed;
            has_length = true;
        }
        else if (equal_ci(response->wire + position, colon - position, "transfer-encoding"))
        {
            if (chunked || !equal_ci(response->wire + value, value_end - value, "chunked"))
                return RESPONSE_INVALID;
            chunked = true;
        }
        else if (equal_ci(response->wire + position, colon - position, "content-encoding") &&
                 !equal_ci(response->wire + value, value_end - value, "identity"))
            return RESPONSE_INVALID;
        position = end + 2u;
    }
    if (chunked && has_length)
        return RESPONSE_INVALID;
    if (chunked)
        return chunked_body(response, position, eof);
    size_t available = response->used - position;
    if (response->status == 204u || response->status == 304u)
        content_length = 0, has_length = true;
    if (has_length && available < content_length)
        return eof ? RESPONSE_INVALID : RESPONSE_MORE;
    if (!has_length && !eof)
        return RESPONSE_MORE;
    size_t length = has_length ? content_length : available;
    if (length > BODY_LIMIT)
        return RESPONSE_INVALID;
    memcpy(response->body, response->wire + position, length);
    response->body[length] = '\0';
    response->body_length = length;
    return RESPONSE_COMPLETE;
}
