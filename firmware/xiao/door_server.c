#include "door_server.h"
#include "door_root_ca.h"
#include "api_settings.h"
#include "audio_upload.h"
#include "upload_settings.h"
#include "net_stream.h"
#include "voice_stream.h"
#include "xlog.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SERVER_HOST DOOR_API_HOST
#define RESPONSE_DEADLINE_MS 30000u
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
static response_state_t parse_response(response_t *response, bool eof)
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

static bool hostname_valid(const char *host)
{
    size_t length = strlen(host), label_length = 0;
    if (!length || length >= 128u) return false;
    for (size_t i = 0; i < length; ++i)
    {
        unsigned char c = (unsigned char)host[i];
        if (c == '.') {
            if (!label_length || host[i - 1u] == '-') return false;
            label_length = 0;
        } else {
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || (c == '-' && label_length)))
                return false;
            if (++label_length > 63u) return false;
        }
    }
    return label_length && host[length - 1u] != '-';
}

static bool token_valid(const char *token, size_t minimum)
{
    size_t length = strlen(token);
    if (length < minimum || length >= 512u) return false;
    for (const unsigned char *p = (const unsigned char *)token; *p; ++p)
        if (*p < 0x21u || *p > 0x7eu) return false;
    return true;
}

static bool api_configured(void)
{
    return hostname_valid(SERVER_HOST) && token_valid(DOOR_API_KEY, 32u);
}

/* Only true means the whole response arrived. */
static bool send_bytes(net_stream_t *stream, uint32_t started, const void *data, size_t length)
{
    const uint8_t *p = data;
    while (length) {
        if (net_now_ms() - started >= RESPONSE_DEADLINE_MS) {
            xlog("[SERVER] HTTP response deadline exceeded.\n");
            return false;
        }
        int sent = net_stream_write(stream, p, length);
        if (sent < 0 || (size_t)sent > length) {
            xlog("[SERVER] HTTP send failed.\n");
            return false;
        }
        if (!sent) net_sleep_ms(1);
        p += sent; length -= (size_t)sent;
    }
    return true;
}

static bool request_endpoint(const char *path, audio_store_t *audio, unsigned slot)
{
    const char *host = audio ? AUDIO_UPLOAD_HOST : SERVER_HOST;
    const char *root_ca = audio ? AUDIO_UPLOAD_CA_PEM : DOOR_ROOT_CA_PEM;
    response_t *response = calloc(1u, sizeof(*response));
    net_stream_t *stream = NULL;
    bool success = false;
    if (response == NULL)
    {
        xlog("[SERVER] Not enough memory for HTTP response.\n");
        return false;
    }
    xlog("[SERVER] HTTPS %s https://%s%s (certificate and hostname verification enabled).\n",
         audio ? "PUT" : "GET", host, path);
    stream = net_stream_open(host, 443, root_ca);
    if (!stream)
    {
        xlog("[SERVER] TCP/TLS connection failed; check Internet, clock, and CA certificate.\n");
        goto cleanup;
    }

    /* The application deadline starts after blocking TCP/TLS establishment. */
    uint32_t started = net_now_ms();
    char request[1024];
    int request_length;
    if (audio) {
        request_length = snprintf(request, sizeof(request),
            "PUT %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
            "Content-Type: audio/wav\r\nContent-Length: %lu\r\n"
            "X-Audio-Match-Score: %.5f\r\nX-Audio-Model-Version: %u\r\n"
            "Accept-Encoding: identity\r\nConnection: close\r\n\r\n", path, host, AUDIO_UPLOAD_TOKEN,
            (unsigned long)(audio->record[slot].length + 44u),
            (double)audio->record[slot].score, AUDIO_MODEL_VERSION);
    } else {
        request_length = snprintf(request, sizeof(request),
            "GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
            "User-Agent: monban-xiao/0.1\r\nAccept: application/json\r\n"
            "Accept-Encoding: identity\r\nConnection: close\r\n\r\n", path, host, DOOR_API_KEY);
    }
    if (request_length <= 0 || (size_t)request_length >= sizeof(request)) goto cleanup;
    if (!send_bytes(stream, started, request, (size_t)request_length)) goto cleanup;
    if (audio) {
        uint8_t chunk[1024];
        uint32_t total = audio->record[slot].length + 44u;
        for (uint32_t offset = 0; offset < total;) {
            uint32_t n;
            /* A call owns the network and flash; retry this recording afterwards. */
            if (voice_stream_busy()) goto cleanup;
            if (offset == 0) { audio_wav_header(chunk, audio->record[slot].samples); n = 44; }
            else {
                n = total - offset; if (n > sizeof(chunk)) n = sizeof(chunk);
                if (!audio_store_read_audio(audio, slot, offset - 44, chunk, n)) goto cleanup;
            }
            if (!send_bytes(stream, started, chunk, n)) goto cleanup;
            offset += n;
        }
    }
    for (;;)
    {
        response_state_t state = parse_response(response, false);
        if (state == RESPONSE_COMPLETE) break;
        if (state == RESPONSE_INVALID || response->used == WIRE_LIMIT)
        {
            xlog("[SERVER] Invalid, unsupported, or oversized HTTP response.\n");
            goto cleanup;
        }
        if (net_now_ms() - started >= RESPONSE_DEADLINE_MS)
        {
            xlog("[SERVER] HTTP response deadline exceeded.\n");
            goto cleanup;
        }
        int received = net_stream_read(stream, response->wire + response->used, WIRE_LIMIT - response->used);
        if (received < 0)
        {
            if (parse_response(response, true) != RESPONSE_COMPLETE)
            {
                xlog("[SERVER] Connection closed before a complete HTTP response.\n");
                goto cleanup;
            }
            break;
        }
        if (!received) { net_sleep_ms(5); continue; }
        response->used += (size_t)received;
    }
    for (size_t i = 0; i < response->body_length; ++i)
    {
        unsigned char c = (unsigned char)response->body[i];
        if ((c < 0x20u && c != '\r' && c != '\n' && c != '\t') || c == 0x7fu)
        {
            xlog("[SERVER] Response body contains unexpected control bytes.\n");
            goto cleanup;
        }
    }
    const char *body_log = response->body;
    if ((DOOR_API_KEY[0] && strstr(body_log, DOOR_API_KEY)) ||
        (AUDIO_UPLOAD_TOKEN[0] && strstr(body_log, AUDIO_UPLOAD_TOKEN)))
        body_log = "[redacted: response contains credentials]";
    xlog("[SERVER] %s HTTP %u; body (%lu bytes): %s\n", path, response->status,
         (unsigned long)response->body_length, body_log);
    if (audio) {
        const char *id = strrchr(path, '/') + 1;
        success = (response->status == 200u || response->status == 201u) &&
                  response->body_length == 33u && response->body[32] == '\n' &&
                  memcmp(response->body, id, 32u) == 0;
    } else success = response->status == 200u;

cleanup:
    if (stream) net_stream_close(stream);
    free(response);
    return success;
}

bool door_server_check(void)
{
    if (!api_configured())
    {
        xlog("[SERVER] API configuration missing/invalid. Run python3 configure_api.py, then rebuild.\n");
        return false;
    }
    bool status = request_endpoint("/api/status", NULL, 0);
    if (status)
        xlog("[SERVER] Authenticated HTTPS status check passed.\n");
    return status;
}

bool audio_upload_configured(void)
{
    /* Prevent configuration values from injecting request headers. */
    return hostname_valid(AUDIO_UPLOAD_HOST) && token_valid(AUDIO_UPLOAD_TOKEN, 1u) &&
        strlen(AUDIO_UPLOAD_CA_PEM) > 0u;
}

bool audio_upload(audio_store_t *audio, unsigned slot)
{
    if (!audio || !audio_upload_configured() || slot < AUDIO_EVENT_FIRST_SLOT || slot >= AUDIO_SLOT_COUNT ||
        !audio->valid[slot]) return false;
    char path[80];
    const uint32_t *id = audio->record[slot].id;
    snprintf(path, sizeof(path), "/v1/doorbell/recordings/%08lx%08lx%08lx%08lx",
        (unsigned long)id[0], (unsigned long)id[1], (unsigned long)id[2], (unsigned long)id[3]);
    return request_endpoint(path, audio, slot);
}
