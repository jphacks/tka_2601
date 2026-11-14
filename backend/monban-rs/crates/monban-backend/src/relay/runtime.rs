//! The boundary between the relay and the voice pipeline (Issue #79).
//!
//! The relay owns the device protocol; a [`VoiceRuntime`] owns ASR, the LLM and TTS. The
//! runtime hands its audio and transcripts to the relay through an [`OutputSink`]. This is
//! the Rust counterpart of `relay/agent.py`'s `DeviceAgent` and `DeviceAudioOutput`.

use std::sync::{Arc, RwLock, Weak};
use std::time::Duration;

use crate::app::{AppInner, AppState};
use crate::persistence::device_api::ShopProfile;

/// Where a runtime sends one reply. Errors carry a [`super::RelayError`] (or a disconnect)
/// that the runtime must return unchanged from `reply`/`recognize` (for example with `?`),
/// so the relay can report the same code Python reports.
#[async_trait::async_trait]
pub trait OutputSink: Send + Sync {
    /// One chunk of 16 kHz mono 16-bit PCM: 1..=640 bytes, even length. Waits while ten
    /// frames are unacknowledged (up to 10 s); the first chunk also sends `output_start`.
    async fn write_audio(&self, pcm: Vec<u8>) -> anyhow::Result<()>;
    /// The reply's audio is complete: sends `output_end`. Requires at least one chunk.
    async fn finish_audio(&self) -> anyhow::Result<()>;
    /// Waits until the device reports `playback_done` for this reply (all frames
    /// acknowledged). The relay requires the reply to finish only after this.
    async fn wait_played(&self) -> anyhow::Result<()>;
    /// Record a final transcript line (`visitor` or `ai`) and forward it to the device.
    async fn transcript(&self, speaker: &str, text: &str) -> anyhow::Result<()>;
}

/// One call's voice pipeline.
#[async_trait::async_trait]
pub trait VoiceRuntime: Send + Sync {
    /// Prepare the session (the relay allows 55 s) before `ready` is sent.
    async fn start(&self) -> anyhow::Result<()>;
    /// Transcribe one complete utterance and report it with `transcript("visitor", ..)`.
    async fn recognize(&self, pcm: Vec<u8>) -> anyhow::Result<String>;
    /// Speak the greeting (`None`) or answer `text`. Producing no audio is a valid
    /// "no reply". With audio: `write_audio`..., `finish_audio`, `wait_played`, then the
    /// assistant's `transcript("ai", ..)`, all before returning.
    async fn reply(&self, text: Option<String>) -> anyhow::Result<()>;
    /// Whether the reply that just finished should end the call.
    fn end_after_reply(&self) -> bool;
    /// Whether the visitor was handed to staff (saved as the visit's outcome).
    fn staff_requested(&self) -> bool;
    /// Release model clients and background work.
    async fn close(&self);
}

/// What the relay knows when it builds a runtime.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeConfig {
    pub house_rules: String,
    /// Set only for a shop device, together with `shop` (reception agent).
    pub device_key: Option<String>,
    pub shop: Option<ShopProfile>,
}

pub trait RuntimeFactory: Send + Sync {
    fn create(&self, config: RuntimeConfig, sink: Arc<dyn OutputSink>) -> Arc<dyn VoiceRuntime>;
}

/// Protocol deadlines of `relay/v2.py`. Tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timings {
    /// From `ready` until `call_started`.
    pub call_start: Duration,
    pub response: Duration,
    pub playback: Duration,
    pub end: Duration,
    pub listen: Duration,
    pub input_start: Duration,
    pub input_recording: Duration,
    pub input_frame_gap: Duration,
    pub played_to_next: Duration,
    pub ack_wait: Duration,
    pub send: Duration,
    pub runtime_start: Duration,
    pub cleanup: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        // E84 after `ready`: M5 TCP connect 10 s + HELLO/READY 10 s + PING/PONG 5 s, then
        // up to 65 s waiting for CALL_STARTED. The server must outlast that so the device
        // times out first and reports its own reason instead of this side's time_limit.
        Self {
            call_start: Duration::from_secs(100),
            response: Duration::from_secs(90),
            playback: Duration::from_secs(75),
            end: Duration::from_secs(65),
            listen: Duration::from_secs(60),
            input_start: Duration::from_secs(60),
            input_recording: Duration::from_secs(35),
            input_frame_gap: Duration::from_secs(5),
            played_to_next: Duration::from_secs(10),
            ack_wait: Duration::from_secs(10),
            send: Duration::from_secs(5),
            runtime_start: Duration::from_secs(55),
            cleanup: Duration::from_secs(10),
        }
    }
}

/// The runtime factory and timings the relay uses.
#[derive(Clone)]
pub struct RelayConfig {
    pub factory: Arc<dyn RuntimeFactory>,
    pub timings: Timings,
}

static DEFAULT: RwLock<Option<RelayConfig>> = RwLock::new(None);
#[allow(clippy::type_complexity)]
static PER_APP: RwLock<Vec<(Weak<AppInner>, RelayConfig)>> = RwLock::new(Vec::new());

/// Register the process-wide runtime factory (call once at startup).
pub fn set_runtime_factory(factory: Arc<dyn RuntimeFactory>) {
    *DEFAULT.write().expect("relay config lock") =
        Some(RelayConfig { factory, timings: Timings::default() });
}

/// Use `config` for relays served by `state` only (tests run several apps in one process).
pub fn configure_for(state: &AppState, config: RelayConfig) {
    let mut entries = PER_APP.write().expect("relay config lock");
    entries.retain(|(app, _)| app.strong_count() > 0 && !std::ptr::eq(app.as_ptr(), Arc::as_ptr(state)));
    entries.push((Arc::downgrade(state), config));
}

pub(crate) fn config_for(state: &AppState) -> Option<RelayConfig> {
    let entries = PER_APP.read().expect("relay config lock");
    if let Some((_, config)) = entries.iter().find(|(app, _)| std::ptr::eq(app.as_ptr(), Arc::as_ptr(state))) {
        return Some(config.clone());
    }
    drop(entries);
    DEFAULT.read().expect("relay config lock").clone()
}
