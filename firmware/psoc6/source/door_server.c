#include "door_server.h"
#include "door_root_ca.h"
#include "audio_upload.h"
#include "upload_settings.h"
#include "cy_secure_sockets.h"
#include "FreeRTOS.h"
#include "task.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SERVER_HOST "door-api.shionkk.f5.si"
#define IO_TIMEOUT_MS 10000u
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

static bool health_ok(const char *body)
{
    static const char *const tokens[] = {"{", "\"status\"", ":", "\"ok\"", "}"};
    for (size_t i = 0; i < sizeof(tokens) / sizeof(tokens[0]); ++i)
    {
        body += strspn(body, " \t\r\n");
        size_t length = strlen(tokens[i]);
        if (strncmp(body, tokens[i], length) != 0)
            return false;
        body += length;
    }
    return body[strspn(body, " \t\r\n")] == '\0';
}

static bool set_io_deadline(cy_socket_t socket, TickType_t started, int option)
{
    TickType_t elapsed = xTaskGetTickCount() - started;
    TickType_t deadline = pdMS_TO_TICKS(RESPONSE_DEADLINE_MS);
    if (elapsed >= deadline)
    {
        printf("[SERVER] HTTP response deadline exceeded.\n");
        return false;
    }
    uint32_t remaining_ms = (uint32_t)(((uint64_t)(deadline - elapsed) * 1000u) / configTICK_RATE_HZ);
    uint32_t timeout = remaining_ms < IO_TIMEOUT_MS ? remaining_ms : IO_TIMEOUT_MS;
    if (timeout == 0) timeout = 1;
    cy_rslt_t result = cy_socket_setsockopt(socket, CY_SOCKET_SOL_SOCKET, option, &timeout, sizeof(timeout));
    if (result != CY_RSLT_SUCCESS)
        printf("[SERVER] Socket timeout setup failed: 0x%08lx.\n", (unsigned long)result);
    return result == CY_RSLT_SUCCESS;
}

static bool request_endpoint(const cy_socket_ip_address_t *address, const char *path, bool check_health,
                             audio_store_t *audio, unsigned slot)
{
    const char *host = audio ? AUDIO_UPLOAD_HOST : SERVER_HOST;
    const char *root_ca = audio ? AUDIO_UPLOAD_CA_PEM : DOOR_ROOT_CA_PEM;
    cy_socket_t socket = CY_SOCKET_INVALID_HANDLE;
    response_t *response = calloc(1u, sizeof(*response));
    bool success = false;
    const char *step = "socket creation";
    cy_rslt_t result;
    if (response == NULL)
    {
        printf("[SERVER] Not enough memory for HTTP response.\n");
        return false;
    }
    cy_socket_sockaddr_t remote = {.port = 443, .ip_address = *address};
    uint32_t timeout = IO_TIMEOUT_MS;
    cy_socket_tls_auth_mode_t auth = CY_SOCKET_TLS_VERIFY_REQUIRED;
    result = cy_socket_create(CY_SOCKET_DOMAIN_AF_INET, CY_SOCKET_TYPE_STREAM, CY_SOCKET_IPPROTO_TLS, &socket);
    if (result != CY_RSLT_SUCCESS) goto socket_error;
#define SET_OPTION(level, option, value, length) do { \
    step = "TLS/socket configuration"; \
    result = cy_socket_setsockopt(socket, (level), (option), (value), (uint32_t)(length)); \
    if (result != CY_RSLT_SUCCESS) goto socket_error; \
} while (0)
    SET_OPTION(CY_SOCKET_SOL_SOCKET, CY_SOCKET_SO_SNDTIMEO, &timeout, sizeof(timeout));
    SET_OPTION(CY_SOCKET_SOL_SOCKET, CY_SOCKET_SO_RCVTIMEO, &timeout, sizeof(timeout));
    SET_OPTION(CY_SOCKET_SOL_TLS, CY_SOCKET_SO_TLS_AUTH_MODE, &auth, sizeof(auth));
    SET_OPTION(CY_SOCKET_SOL_TLS, CY_SOCKET_SO_TRUSTED_ROOTCA_CERTIFICATE,
               root_ca, strlen(root_ca));
    SET_OPTION(CY_SOCKET_SOL_TLS, CY_SOCKET_SO_SERVER_NAME_INDICATION,
               host, strlen(host));
    SET_OPTION(CY_SOCKET_SOL_TLS, CY_SOCKET_SO_ALPN_PROTOCOLS, "http/1.1", strlen("http/1.1"));
#undef SET_OPTION
    printf("[SERVER] HTTPS %s %s (certificate and hostname verification enabled).\n", audio ? "PUT" : "GET", path);
    step = "TCP/TLS connection; check Internet, clock, and CA certificate";
    result = cy_socket_connect(socket, &remote, sizeof(remote));
    if (result != CY_RSLT_SUCCESS) goto socket_error;

    /* The application deadline starts after blocking TCP/TLS establishment. */
    TickType_t started = xTaskGetTickCount();
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
            "GET %s HTTP/1.1\r\nHost: %s\r\n"
            "User-Agent: door-board/0.1\r\nAccept: application/json\r\n"
            "Accept-Encoding: identity\r\nConnection: close\r\n\r\n", path, host);
    }
    if (request_length <= 0 || (size_t)request_length >= sizeof(request)) goto cleanup;
    for (uint32_t sent = 0; sent < (uint32_t)request_length;)
    {
        if (!set_io_deadline(socket, started, CY_SOCKET_SO_SNDTIMEO)) goto cleanup;
        uint32_t count = 0;
        step = "HTTP request send";
        result = cy_socket_send(socket, request + sent, (uint32_t)request_length - sent, CY_SOCKET_FLAGS_NONE, &count);
        if (result != CY_RSLT_SUCCESS) goto socket_error;
        if (count == 0 || count > (uint32_t)request_length - sent)
        {
            printf("[SERVER] HTTP send made no valid progress.\n");
            goto cleanup;
        }
        sent += count;
    }
    if (audio) {
        uint8_t chunk[1024];
        uint32_t total = audio->record[slot].length + 44u;
        for (uint32_t offset = 0; offset < total;) {
            uint32_t n;
            if (offset == 0) { audio_wav_header(chunk, audio->record[slot].samples); n = 44; }
            else {
                n = total - offset; if (n > sizeof(chunk)) n = sizeof(chunk);
                if (!audio_store_read_audio(audio, slot, offset - 44, chunk, n)) goto cleanup;
            }
            for (uint32_t sent = 0; sent < n;) {
                if (!set_io_deadline(socket, started, CY_SOCKET_SO_SNDTIMEO)) goto cleanup;
                uint32_t count = 0; step = "WAV upload";
                result = cy_socket_send(socket, chunk + sent, n - sent, CY_SOCKET_FLAGS_NONE, &count);
                if (result != CY_RSLT_SUCCESS) goto socket_error;
                if (!count || count > n - sent) goto cleanup;
                sent += count;
            }
            offset += n;
        }
    }
    for (;;)
    {
        response_state_t state = parse_response(response, false);
        if (state == RESPONSE_COMPLETE) break;
        if (state == RESPONSE_INVALID || response->used == WIRE_LIMIT)
        {
            printf("[SERVER] Invalid, unsupported, or oversized HTTP response.\n");
            goto cleanup;
        }
        if (!set_io_deadline(socket, started, CY_SOCKET_SO_RCVTIMEO)) goto cleanup;
        uint32_t received = 0;
        step = "HTTP response receive";
        result = cy_socket_recv(socket, response->wire + response->used,
                                (uint32_t)(WIRE_LIMIT - response->used), CY_SOCKET_FLAGS_NONE, &received);
        if (received > WIRE_LIMIT - response->used) goto cleanup;
        if (result != CY_RSLT_SUCCESS && result != CY_RSLT_MODULE_SECURE_SOCKETS_CLOSED)
            goto socket_error;
        response->used += received;
        if (result == CY_RSLT_MODULE_SECURE_SOCKETS_CLOSED || received == 0)
        {
            if (parse_response(response, true) != RESPONSE_COMPLETE)
            {
                printf("[SERVER] Connection closed before a complete HTTP response.\n");
                goto cleanup;
            }
            break;
        }
    }
    if (xTaskGetTickCount() - started >= pdMS_TO_TICKS(RESPONSE_DEADLINE_MS))
    {
        printf("[SERVER] HTTP response deadline exceeded.\n");
        goto cleanup;
    }
    for (size_t i = 0; i < response->body_length; ++i)
    {
        unsigned char c = (unsigned char)response->body[i];
        if ((c < 0x20u && c != '\r' && c != '\n' && c != '\t') || c == 0x7fu)
        {
            printf("[SERVER] Response body contains unexpected control bytes.\n");
            goto cleanup;
        }
    }
    printf("[SERVER] %s HTTP %u; body (%lu bytes): %s\n", path, response->status,
           (unsigned long)response->body_length, response->body);
    if (audio) {
        const char *id = strrchr(path, '/') + 1;
        size_t n = response->body_length;
        if (n && response->body[n - 1] == '\n') --n;
        success = (response->status == 200u || response->status == 201u) &&
                  n == 32u && memcmp(response->body, id, 32u) == 0;
    } else success = response->status == 200u && (!check_health || health_ok(response->body));
    if (response->status == 200u && check_health && !success)
        printf("[SERVER] Health response did not contain the expected status=ok object.\n");
    goto cleanup;

socket_error:
    printf("[SERVER] %s failed: 0x%08lx.\n", step, (unsigned long)result);
cleanup:
    if (socket != CY_SOCKET_INVALID_HANDLE)
        cy_socket_delete(socket); /* Also disconnects, including failed connections. */
    free(response);
    return success;
}

bool door_server_check(void)
{
    cy_socket_ip_address_t address = {0};
    cy_rslt_t result = cy_socket_gethostbyname(SERVER_HOST, CY_SOCKET_IP_VER_V4, &address);
    if (result != CY_RSLT_SUCCESS)
    {
        printf("[SERVER] DNS lookup failed: 0x%08lx. Check Internet/DNS access.\n", (unsigned long)result);
        return false;
    }
    bool health = request_endpoint(&address, "/health", true, NULL, 0);
    bool status = request_endpoint(&address, "/v1/status", false, NULL, 0);
    if (health && status)
        printf("[SERVER] HTTPS health and status checks passed.\n");
    return health && status;
}

bool audio_upload_configured(void)
{
    /* Prevent configuration values from injecting request headers. */
    return AUDIO_UPLOAD_HOST[0] && AUDIO_UPLOAD_TOKEN[0] && AUDIO_UPLOAD_CA_PEM[0] &&
        strlen(AUDIO_UPLOAD_HOST) < 128 && strlen(AUDIO_UPLOAD_TOKEN) < 512 &&
        strpbrk(AUDIO_UPLOAD_HOST, "/ \t\r\n") == NULL &&
        strpbrk(AUDIO_UPLOAD_TOKEN, "\r\n") == NULL;
}

bool audio_upload(audio_store_t *audio, unsigned slot)
{
    if (!audio_upload_configured() || slot < AUDIO_EVENT_FIRST_SLOT || slot >= AUDIO_SLOT_COUNT ||
        !audio->valid[slot]) return false;
    cy_socket_ip_address_t address = {0};
    if (cy_socket_gethostbyname(AUDIO_UPLOAD_HOST, CY_SOCKET_IP_VER_V4, &address) != CY_RSLT_SUCCESS) return false;
    char path[80];
    const uint32_t *id = audio->record[slot].id;
    snprintf(path, sizeof(path), "/v1/doorbell/recordings/%08lx%08lx%08lx%08lx",
        (unsigned long)id[0], (unsigned long)id[1], (unsigned long)id[2], (unsigned long)id[3]);
    return request_endpoint(&address, path, false, audio, slot);
}
