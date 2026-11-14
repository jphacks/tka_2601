//! Load the local models before a conversation starts (port of `core/warmup.py`).
//!
//! [`warm_models`] probes ASR (0.8 s of silence), the LLM (`max_tokens: 1`, not streamed)
//! and TTS (「はい。」) concurrently and never fails; [`schedule`] runs it in the
//! background once per process, again only after a failed run. [`CallWarmup`] runs it
//! again when a call starts, because on-demand models stop after a minute without requests.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::json;

use crate::config::Settings;

pub const WARMUP_SAMPLE_RATE: u32 = 16_000;
pub const WARMUP_SILENCE_MS: u32 = 800;
pub const WARMUP_TEXT: &str = "はい。";
/// `aiohttp.ClientTimeout(connect=5, ...)`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

fn silence_wav() -> Vec<u8> {
    let samples = (WARMUP_SAMPLE_RATE * WARMUP_SILENCE_MS / 1000) as usize;
    crate::audio::wav_mono16(&vec![0u8; samples * 2], WARMUP_SAMPLE_RATE)
}

/// aiohttp `raise_for_status`.
fn check(response: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    let status = response.status();
    anyhow::ensure!(status.as_u16() < 400, "HTTP {status}");
    Ok(response)
}

async fn warm_asr(http: &reqwest::Client, settings: &Settings, timeout: Duration) -> anyhow::Result<()> {
    let file = reqwest::multipart::Part::bytes(silence_wav()).file_name("warmup.wav").mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("model", settings.asr_model.clone())
        .text("language", "ja")
        .text("response_format", "json");
    let response = http
        .post(format!("{}/v1/audio/transcriptions", settings.asr_base_url))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", settings.asr_api_key))
        .multipart(form)
        .timeout(timeout)
        .send()
        .await?;
    check(response)?.bytes().await?;
    Ok(())
}

async fn warm_llm(http: &reqwest::Client, settings: &Settings, timeout: Duration) -> anyhow::Result<()> {
    let body = json!({
        "model": settings.llm_model,
        "messages": [{"role": "user", "content": "こんにちは"}],
        "stream": false,
        "max_tokens": 1,
        "temperature": 0,
    });
    let response = http
        .post(format!("{}/v1/chat/completions", settings.ollama_base_url))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", settings.llm_api_key))
        .json(&body)
        .timeout(timeout)
        .send()
        .await?;
    check(response)?.bytes().await?;
    Ok(())
}

async fn warm_tts(http: &reqwest::Client, settings: &Settings, timeout: Duration) -> anyhow::Result<()> {
    let response = http
        .post(format!("{}/v1/audio/speech", settings.tts_base_url))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", settings.tts_api_key))
        .json(&super::tts::speech_body(settings, WARMUP_TEXT))
        .timeout(timeout)
        .send()
        .await?;
    let mut stream = check(response)?.bytes_stream();
    while let Some(chunk) = stream.next().await {
        chunk?;
    }
    Ok(())
}

/// Probe ASR, the LLM and TTS once so their models are resident. Never fails; `true` only
/// when every probe succeeded (or warm-up is disabled).
pub async fn warm_models(settings: &Settings) -> bool {
    if !settings.warmup_enabled {
        return true;
    }
    let limit = Duration::from_secs_f64(settings.warmup_timeout_seconds);
    let http = match reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).read_timeout(limit).build() {
        Ok(http) => http,
        Err(error) => {
            tracing::warn!("warm-up could not start: {error}");
            return false;
        }
    };
    let started = Instant::now();
    let (asr, llm, tts) = tokio::join!(
        warm_asr(&http, settings, limit),
        warm_llm(&http, settings, limit),
        warm_tts(&http, settings, limit),
    );
    let mut ok = true;
    for (name, result) in [("asr", asr), ("llm", llm), ("tts", tts)] {
        if let Err(error) = result {
            tracing::warn!("warm-up {name} failed: {error}");
            ok = false;
        }
    }
    tracing::info!("model warm-up finished in {:.1}s (ok={ok})", started.elapsed().as_secs_f64());
    ok
}

static WARMED_OK: AtomicBool = AtomicBool::new(false);
static TASK: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

/// Start one background warm-up for this process, unless one is running or one succeeded.
/// Does nothing outside a Tokio runtime.
pub fn schedule(settings: Arc<Settings>) {
    if !settings.warmup_enabled || WARMED_OK.load(Ordering::SeqCst) {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let mut task = TASK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if task.as_ref().is_some_and(|handle| !handle.is_finished()) {
        return;
    }
    *task = Some(runtime.spawn(async move {
        let ok = warm_models(&settings).await;
        WARMED_OK.store(ok, Ordering::SeqCst);
    }));
}

/// Cancel a warm-up that is still running (e.g. when a short-lived test server stops).
pub async fn shutdown() {
    let handle = TASK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    if let Some(handle) = handle {
        if !handle.is_finished() {
            handle.abort();
            let _ = handle.await;
        }
    }
}

/// Whether a scheduled warm-up has succeeded in this process.
pub fn warmed() -> bool {
    WARMED_OK.load(Ordering::SeqCst)
}

/// A successful call-start warm-up this recent also covers the next call. Modal stops an
/// idle inference container 60 s after its last request (`scaledown_window=60`).
pub const CALL_WARMUP_FRESH: Duration = Duration::from_secs(30);

/// Wakes ASR, the LLM and TTS in the background when a call starts, so a stopped
/// on-demand model boots while the greeting plays and the visitor speaks, not after the
/// visitor has finished. At most one runs at a time; a recent success skips the next.
#[derive(Default)]
pub struct CallWarmup {
    state: Mutex<CallWarmupState>,
}

#[derive(Default)]
struct CallWarmupState {
    task: Option<tokio::task::JoinHandle<()>>,
    last_ok: Option<Instant>,
}

impl CallWarmup {
    /// Start a warm-up unless one is running or one started successfully within `fresh`.
    /// Returns whether one was started. Never blocks the call.
    pub fn wake(self: &Arc<Self>, settings: Arc<Settings>, fresh: Duration) -> bool {
        if !settings.warmup_enabled {
            return false;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return false };
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.task.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return false;
        }
        if state.last_ok.is_some_and(|started| started.elapsed() < fresh) {
            return false;
        }
        let this = Arc::clone(self);
        state.task = Some(runtime.spawn(async move {
            let started = Instant::now();
            tracing::info!("call_warmup_started");
            let ok = warm_models(&settings).await;
            if ok {
                let mut state = this.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                state.last_ok = Some(started);
            }
        }));
        true
    }

    /// Cancel a warm-up that is still running.
    pub async fn shutdown(&self) {
        let handle = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).task.take();
        if let Some(handle) = handle {
            if !handle.is_finished() {
                handle.abort();
                let _ = handle.await;
            }
        }
    }
}
