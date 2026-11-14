#pragma once
#ifdef __cplusplus
extern "C" {
#endif
#include <stdbool.h>
/* Called by the existing network task, never by the real-time audio task.
 * Fetches the app's chime-enrollment request, runs it through the audio_app
 * enrollment API and reports the phase back (Issue #62). One request per call. */
void chime_enroll_sync_step(bool network_ready);
#ifdef __cplusplus
}
#endif
