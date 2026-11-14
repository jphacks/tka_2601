//! The real `/api/relay` with only the speech models and Supabase replaced, for the XIAO
//! firmware's host end-to-end test (`firmware/xiao/tests/e2e_relay_rust.py`).
//!
//! The Rust counterpart of `firmware/xiao/tests/e2e_backend.py`: [`Agent`] speaks the same
//! scripted PCM as its `Agent`, device settings are absent, and the visit history PUT goes
//! to a small HTTP server in this process that counts it.
//!
//! Settings come from the environment (`DOOR_API_KEY`, ...). Prints `E2E_PORT=<port>` once
//! listening. When stdin closes (or on SIGINT/SIGTERM) it waits for open relay sessions,
//! then prints one JSON line: `{"agents":[{"recognized":[<pcm bytes>...],"closed":bool}],
//! "visits":<count>}`.

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::routing::put;
use axum::Router;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use monban_backend::app::{router, AppInner, AppState};
use monban_backend::config::Settings;
use monban_backend::persistence::device_api::DeviceSettings;
use monban_backend::relay::{
    configure_for, OutputSink, RelayConfig, RuntimeConfig, RuntimeFactory, Timings, VoiceRuntime,
};
use monban_backend::services::{HttpError, Services};

/// `b"\x10\x27" * 320`: one 20 ms frame of 16-bit little-endian 10000.
fn frame(samples: usize) -> Vec<u8> {
    [0x10u8, 0x27].repeat(samples)
}

const GREETING_FRAMES: usize = 120;
const REPLY_FRAMES: usize = 60;

/// `e2e_backend.Agent`: the relay's voice runtime, speaking scripted PCM.
struct Agent {
    sink: Arc<dyn OutputSink>,
    recognized: Mutex<Vec<usize>>,
    ended: AtomicBool,
    closed: AtomicBool,
}

#[async_trait::async_trait]
impl VoiceRuntime for Agent {
    async fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn recognize(&self, pcm: Vec<u8>) -> anyhow::Result<String> {
        self.recognized.lock().unwrap().push(pcm.len());
        self.sink.transcript("visitor", "宅配便です。").await?;
        Ok("宅配便です。".into())
    }

    async fn reply(&self, text: Option<String>) -> anyhow::Result<()> {
        let greeting = text.is_none();
        let frames = if greeting { GREETING_FRAMES } else { REPLY_FRAMES };
        let line = if greeting { "はい、どちら様でしょうか。" } else { "玄関の前に置いていただけますか。失礼いたします。" };
        self.sink.transcript("ai", line).await?;
        for _ in 0..frames {
            self.sink.write_audio(frame(320)).await?;
        }
        self.sink.write_audio(frame(100)).await?; // a short final frame
        if !greeting {
            self.ended.store(true, Ordering::SeqCst);
        }
        self.sink.finish_audio().await?;
        self.sink.wait_played().await
    }

    fn end_after_reply(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    fn staff_requested(&self) -> bool {
        false
    }

    async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Factory {
    agents: Mutex<Vec<Arc<Agent>>>,
}

impl RuntimeFactory for Factory {
    fn create(&self, _config: RuntimeConfig, sink: Arc<dyn OutputSink>) -> Arc<dyn VoiceRuntime> {
        let agent = Arc::new(Agent {
            sink,
            recognized: Mutex::new(Vec::new()),
            ended: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        });
        self.agents.lock().unwrap().push(agent.clone());
        agent
    }
}

/// No household settings (`fetch_device_settings` returns None); nothing else is used.
struct NoUpstreams;

#[async_trait::async_trait]
impl Services for NoUpstreams {
    async fn model_available(&self, _: &str, _: &str, _: Option<&str>, _: &str) -> bool {
        false
    }
    async fn llm_available(&self) -> bool {
        false
    }
    async fn livekit_available(&self) -> bool {
        false
    }
    async fn dispatch_agent(&self, _: &str, _: &str, _: Option<Value>) -> anyhow::Result<()> {
        anyhow::bail!("the e2e server has no LiveKit")
    }
    async fn fetch_device_settings(&self, _device_key: &str) -> Option<DeviceSettings> {
        None
    }
    async fn synthesize_preview(&self, _: &str) -> Result<Vec<u8>, HttpError> {
        Err(HttpError::new(503, "the e2e server has no TTS"))
    }
}

/// Supabase stand-in: counts the visit history PUTs.
async fn serve_supabase(visits: Arc<AtomicUsize>) -> anyhow::Result<String> {
    let app = Router::new().route(
        "/functions/v1/device/visits/{visit_id}",
        put(move |axum::Json(_body): axum::Json<Value>| {
            let visits = visits.clone();
            async move {
                visits.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({"ok": true}))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(url)
}

async fn stop_requested() {
    let stdin_closed = async {
        let mut sink = Vec::new();
        let _ = tokio::io::stdin().read_to_end(&mut sink).await;
    };
    #[cfg(unix)]
    let terminated = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminated = std::future::pending::<()>();
    tokio::select! {
        _ = stdin_closed => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = terminated => {}
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).init();

    let visits = Arc::new(AtomicUsize::new(0));
    let supabase_url = serve_supabase(visits.clone()).await?;
    let settings = Settings::from_lookup(&|name| match name {
        "DOOR_SUPABASE_URL" => Some(supabase_url.clone()),
        "DOOR_SUPABASE_ANON_KEY" => {
            Some(std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "e2e-anon".into()))
        }
        _ => std::env::var(name).ok(),
    })?;

    let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).build()?;
    let state: AppState = Arc::new(AppInner::new(Arc::new(settings), http, Arc::new(NoUpstreams)));
    let factory = Arc::new(Factory::default());
    configure_for(&state, RelayConfig { factory: factory.clone(), timings: Timings::default() });

    let host = std::env::var("MONBAN_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("MONBAN_PORT").unwrap_or_else(|_| "0".into());
    let listener = TcpListener::bind(format!("{host}:{port}")).await?;
    let port = listener.local_addr()?.port();
    let app = router(state.clone());
    let stopped = Arc::new(Notify::new());
    let server = {
        let stopped = stopped.clone();
        tokio::spawn(async move {
            axum::serve(listener, app).with_graceful_shutdown(async move { stopped.notified().await }).await
        })
    };
    println!("E2E_PORT={port}");
    std::io::stdout().flush()?;

    stop_requested().await;
    // Let a finished call write its visit history before reporting.
    for _ in 0..200 {
        if state.relay_sessions.load(Ordering::SeqCst) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    stopped.notify_one();
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;

    let agents: Vec<Value> = factory
        .agents
        .lock()
        .unwrap()
        .iter()
        .map(|agent| {
            json!({
                "recognized": *agent.recognized.lock().unwrap(),
                "closed": agent.closed.load(Ordering::SeqCst),
            })
        })
        .collect();
    println!("{}", json!({"agents": agents, "visits": visits.load(Ordering::SeqCst)}));
    std::io::stdout().flush()?;
    // stdin may still be read by a blocking thread after a signal; do not wait for it.
    std::process::exit(0);
}
