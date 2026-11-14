#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Pure serializer. Returns the datagram length, or 0 on invalid input/truncation.
 * token is exactly 64 lowercase hexadecimal characters (32 random bytes).
 * id uses the same word order as the recording-upload event ID. */
size_t m5_message_format(char *output, size_t capacity, const uint32_t id[4],
                         float score, const char *token);

/* Diagnostic-only ping/pong. The reply uses the exact canonical wire format
 * produced here, including key order, with no newline or trailing bytes. */
size_t m5_probe_format(char *output, size_t capacity, const uint32_t id[4],
                       const char *token, bool reply);
bool m5_probe_reply_matches(const char *packet, size_t length,
                            const uint32_t id[4], const char *token);
