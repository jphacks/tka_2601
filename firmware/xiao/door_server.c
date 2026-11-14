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
#include "bounded_http.h"

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
