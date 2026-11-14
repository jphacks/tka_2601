#include "storage_worker.h"
#include "audio_app.h"
#include "audio_link.h"
#include "audio_upload.h"
#include "net_stream.h"
#include "net_state.h"
#include "voice_stream.h"
#include "xlog.h"
#include <string.h>

static audio_store_t store;
static bool available;
static uint32_t retry_at;
static bool retry_pending;
static unsigned next_slot = AUDIO_EVENT_FIRST_SLOT;
static bool quarantined[AUDIO_SLOT_COUNT];

bool audio_storage_ready(void) { return available && store.ready; }

void storage_worker_begin(audio_flash_t flash, bool flash_available)
{
    available = flash_available;
    retry_pending = false;
    next_slot = AUDIO_EVENT_FIRST_SLOT;
    memset(quarantined, 0, sizeof(quarantined));
    if (!available) {
        memset(&store, 0, sizeof(store));
        xlog("[AUDIO] audio_store partition unavailable. No persistent model or recording possible.\n");
        return;
    }
    if (audio_store_open(&store, flash)) {
        bool loaded = audio_store_load_model(&store, audio_app_model());
        xlog("[AUDIO] Storage ready; registered model %s.\n", loaded ? "loaded" : "not found");
    } else xlog("[AUDIO] Storage uninitialized. Enter FORMAT_AUDIO_STORAGE to prepare it.\n");
}
static bool retry_due(void)
{
    return !retry_pending || (int32_t)(net_now_ms() - retry_at) >= 0;
}
void storage_worker_step(void)
{
    volatile audio_link_t *link = audio_link();
    audio_link_acquire();
    /* Flash work stalls the caches and an upload competes for the network, so
     * both wait until a call has fully finished. */
    if (link->voice_call_active || link->voice_call_ack || voice_stream_busy()) return;
    if (audio_jobs.formatting) {
        bool ok = available && audio_store_format(&store);
        if (ok) memset(quarantined, 0, sizeof(quarantined));
        audio_jobs.formatting = false;
        xlog("[AUDIO] Storage format %s.\n", ok ? "complete; enter e to register" : "FAILED");
    } else if (audio_jobs.model_busy) {
        bool ok = audio_store_save_model(&store, &audio_jobs.model_to_save);
        audio_jobs.model_busy = false;
        xlog("[SETUP] Model persistence %s.\n", ok ? "verified" : "FAILED; current model is RAM-only");
    } else if (audio_jobs.clip_saving) {
        uint32_t id[4];
        net_random(id, sizeof(id));
        bool ok = audio_store_enqueue(&store, audio_jobs.pending_pcm, audio_jobs.pending_samples, id, audio_jobs.pending_score);
        audio_jobs.clip_saving = false;
        audio_jobs.clip_busy = false;
        xlog("[AUDIO] Recording %s.\n", ok ? "saved to flash; awaiting server ACK" : "NOT SAVED (storage full/uninitialized/I/O error)");
    }
    if (!net_voice_ready() || !audio_upload_configured() || !retry_due()) return;
    int slot = -1;
    for (unsigned attempt = AUDIO_EVENT_FIRST_SLOT; attempt < AUDIO_SLOT_COUNT; ++attempt) {
        unsigned i = next_slot;
        next_slot = i + 1 == AUDIO_SLOT_COUNT ? AUDIO_EVENT_FIRST_SLOT : i + 1;
        if (store.ready && store.valid[i] && store.record[i].acknowledged && !quarantined[i]) { slot = (int)i; break; }
    }
    if (slot < 0) return;
    if (!audio_store_verify(&store, (unsigned)slot)) {
        quarantined[slot] = true;
        xlog("[UPLOAD] Corrupt recording quarantined in slot %u; other recordings remain eligible.\n", (unsigned)slot);
        return;
    }
    bool ok = audio_upload(&store, (unsigned)slot);
    if (ok) ok = audio_store_ack(&store, (unsigned)slot);
    xlog("[UPLOAD] %s.\n", ok ? "Server ACK saved; slot reusable" : "Unconfirmed; retaining recording for retry");
    retry_pending = true;
    retry_at = net_now_ms() + (ok ? 1000u : 30000u);
}
