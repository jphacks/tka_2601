#pragma once
/* Copy to upload_config.h (Git-ignored). Set ONLY after the receiver is deployed.
 * Hostname only: no scheme, port or path. Transport is HTTPS port 443.
 * The default CA is GTS Root R4; replace with the receiver's trust anchor if needed. */
#define AUDIO_UPLOAD_HOST ""
#define AUDIO_UPLOAD_TOKEN ""
/* #define AUDIO_UPLOAD_CA_PEM "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n" */
