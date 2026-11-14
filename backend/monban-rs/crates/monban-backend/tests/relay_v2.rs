//! `/api/relay` protocol v2 over a real socket (port of `tests/test_relay_v2.py` and the
//! start/authentication cases of `tests/test_relay.py`).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::routing::put;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use monban_backend::app::{router, AppInner, AppState};
use monban_backend::config::Settings;
use monban_backend::persistence::device_api::{DeviceSettings, ShopProfile};
use monban_backend::relay::{
    configure_for, OutputSink, RelayConfig, RuntimeConfig, RuntimeFactory, Timings, VoiceRuntime,
};
use monban_backend::services::{HttpError, Services};
use monban_policy::house_rules::{base_rules, HouseSettings, Mode};

const API_KEY: &str = "relay-test-api-key-with-more-than-32-bytes";
const DEVICE_KEY: &str = "device-key";

fn pcm() -> Vec<u8> {
    [1u8, 0].repeat(320)
}

// ------------------------------------------------------------------------------------
// Fakes
// ------------------------------------------------------------------------------------

#[derive(Default)]
struct FakeServices {
    device: Mutex<Option<DeviceSettings>>,
    settings_keys: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Services for FakeServices {
    async fn model_available(&self, _: &str, _: &str, _: Option<&str>, _: &str) -> bool {
        true
    }
    async fn llm_available(&self) -> bool {
        true
    }
    async fn livekit_available(&self) -> bool {
        true
    }
    async fn dispatch_agent(&self, _: &str, _: &str, _: Option<Value>) -> anyhow::Result<()> {
        anyhow::bail!("the relay must not dispatch a LiveKit agent")
    }
    async fn fetch_device_settings(&self, device_key: &str) -> Option<DeviceSettings> {
        self.settings_keys.lock().unwrap().push(device_key.to_string());
        self.device.lock().unwrap().clone()
    }
    async fn synthesize_preview(&self, _: &str) -> Result<Vec<u8>, HttpError> {
        Err(HttpError::new(503, "unused"))
    }
}

/// The relay tests' `FakeAgent`.
struct FakeRuntime {
    config: RuntimeConfig,
    sink: Arc<dyn OutputSink>,
    recognized: Mutex<Vec<Vec<u8>>>,
    end: AtomicBool,
    no_reply: AtomicBool,
    closed: AtomicBool,
    played: AtomicBool,
    frames: AtomicUsize,
    reply_count: AtomicUsize,
    text: Mutex<String>,
    staff: AtomicBool,
}

#[async_trait::async_trait]
impl VoiceRuntime for FakeRuntime {
    async fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn recognize(&self, pcm: Vec<u8>) -> anyhow::Result<String> {
        self.recognized.lock().unwrap().push(pcm);
        let text = self.text.lock().unwrap().clone();
        self.sink.transcript("visitor", &text).await?;
        Ok(text)
    }
    async fn reply(&self, text: Option<String>) -> anyhow::Result<()> {
        self.reply_count.fetch_add(1, Ordering::SeqCst);
        if text.is_some() && self.no_reply.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.played.store(false, Ordering::SeqCst);
        for _ in 0..self.frames.load(Ordering::SeqCst) {
            self.sink.write_audio(pcm()).await?;
        }
        self.sink.finish_audio().await?;
        self.sink.wait_played().await?;
        self.played.store(true, Ordering::SeqCst);
        let line = if text.is_none() { "はい、どちら様でしょうか。" } else { "玄関前にお願いします。" };
        self.sink.transcript("ai", line).await
    }
    fn end_after_reply(&self) -> bool {
        self.end.load(Ordering::SeqCst)
    }
    fn staff_requested(&self) -> bool {
        self.staff.load(Ordering::SeqCst)
    }
    async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeFactory {
    runtimes: Mutex<Vec<Arc<FakeRuntime>>>,
    created: Notify,
}

impl FakeFactory {
    async fn runtime(&self) -> Arc<FakeRuntime> {
        loop {
            let notified = self.created.notified();
            if let Some(runtime) = self.runtimes.lock().unwrap().first() {
                return runtime.clone();
            }
            tokio::time::timeout(Duration::from_secs(5), notified).await.expect("runtime was created");
        }
    }
}

impl RuntimeFactory for FakeFactory {
    fn create(&self, config: RuntimeConfig, sink: Arc<dyn OutputSink>) -> Arc<dyn VoiceRuntime> {
        let runtime = Arc::new(FakeRuntime {
            config,
            sink,
            recognized: Mutex::new(Vec::new()),
            end: AtomicBool::new(false),
            no_reply: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            played: AtomicBool::new(false),
            frames: AtomicUsize::new(2),
            reply_count: AtomicUsize::new(0),
            text: Mutex::new("宅配便です。".into()),
            staff: AtomicBool::new(false),
        });
        self.runtimes.lock().unwrap().push(runtime.clone());
        self.created.notify_waiters();
        runtime
    }
}

// ------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------

struct Harness {
    address: String,
    factory: Arc<FakeFactory>,
    services: Arc<FakeServices>,
    visits: Arc<Mutex<Vec<Value>>>,
    visit_written: Arc<Notify>,
    _state: AppState,
}

async fn harness_with(timings: Timings, env: &[(&str, &str)]) -> Harness {
    // Supabase stand-in that records the visit history PUT.
    let visits = Arc::new(Mutex::new(Vec::new()));
    let visit_written = Arc::new(Notify::new());
    let supabase = {
        let visits = visits.clone();
        let written = visit_written.clone();
        Router::new().route(
            "/functions/v1/device/visits/{visit_id}",
            put(move |axum::Json(body): axum::Json<Value>| {
                let visits = visits.clone();
                let written = written.clone();
                async move {
                    visits.lock().unwrap().push(body);
                    written.notify_waiters();
                    axum::Json(json!({"ok": true}))
                }
            }),
        )
    };
    let supabase_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let supabase_url = format!("http://{}", supabase_listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(supabase_listener, supabase).await.unwrap() });

    let mut values: Vec<(String, String)> = vec![
        ("DOOR_API_KEY".into(), API_KEY.into()),
        ("DOOR_SUPABASE_URL".into(), supabase_url),
        ("DOOR_SUPABASE_ANON_KEY".into(), "anon".into()),
    ];
    values.extend(env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let settings = Settings::from_lookup(&move |name| {
        values.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    })
    .expect("test settings");
    let services = Arc::new(FakeServices::default());
    let state: AppState = Arc::new(AppInner::new(Arc::new(settings), reqwest::Client::new(), services.clone()));
    let factory = Arc::new(FakeFactory::default());
    configure_for(&state, RelayConfig { factory: factory.clone(), timings });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let app = router(state.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Harness { address, factory, services, visits, visit_written, _state: state }
}

async fn harness() -> Harness {
    harness_with(Timings::default(), &[]).await
}

impl Harness {
    async fn connect_with(&self, authorization: Option<&str>) -> Result<Ws, String> {
        let mut request = format!("ws://{}/api/relay", self.address).into_client_request().unwrap();
        if let Some(value) = authorization {
            request.headers_mut().insert("Authorization", value.parse().unwrap());
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((stream, _)) => Ok(Ws { stream, transcripts: Vec::new() }),
            Err(error) => Err(error.to_string()),
        }
    }

    async fn connect(&self) -> Ws {
        self.connect_with(Some(&format!("Bearer {API_KEY}"))).await.expect("handshake")
    }

    /// Wait for the visit history PUT that follows the end of a call.
    async fn visit(&self) -> Value {
        for _ in 0..50 {
            let notified = self.visit_written.notified();
            if let Some(visit) = self.visits.lock().unwrap().first() {
                return visit.clone();
            }
            let _ = tokio::time::timeout(Duration::from_millis(100), notified).await;
        }
        panic!("no visit was written");
    }

    /// Let a finished call's cleanup run before asserting that nothing was written.
    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

type Stream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Ws {
    stream: Stream,
    transcripts: Vec<Value>,
}

#[derive(Debug, PartialEq)]
enum Frame {
    Json(Value),
    Bytes(Vec<u8>),
    Closed(Option<u16>),
}

impl Ws {
    async fn send_json(&mut self, value: Value) {
        self.stream.send(Message::Text(value.to_string().into())).await.unwrap();
    }

    async fn send_text(&mut self, text: &str) {
        self.stream.send(Message::Text(text.to_string().into())).await.unwrap();
    }

    async fn send_bytes(&mut self, bytes: Vec<u8>) {
        self.stream.send(Message::Binary(bytes.into())).await.unwrap();
    }

    async fn next(&mut self) -> Frame {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), self.stream.next())
                .await
                .expect("a message within five seconds");
            return match message {
                Some(Ok(Message::Text(text))) => Frame::Json(serde_json::from_str(&text).unwrap()),
                Some(Ok(Message::Binary(bytes))) => Frame::Bytes(bytes.to_vec()),
                Some(Ok(Message::Close(frame))) => Frame::Closed(frame.map(|f| u16::from(f.code))),
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => Frame::Closed(None),
            };
        }
    }

    /// The next control message, collecting transcripts on the way (Python's `control`).
    async fn control(&mut self) -> Value {
        loop {
            match self.next().await {
                Frame::Json(value) if value["type"] == "transcript" => self.transcripts.push(value),
                Frame::Json(value) => return value,
                other => panic!("expected JSON, got {other:?}"),
            }
        }
    }

    async fn receive_bytes(&mut self) -> Vec<u8> {
        match self.next().await {
            Frame::Bytes(bytes) => bytes,
            other => panic!("expected PCM, got {other:?}"),
        }
    }

    async fn closed(&mut self) -> Option<u16> {
        loop {
            match self.next().await {
                Frame::Closed(code) => return code,
                Frame::Json(value) if value["type"] == "transcript" => self.transcripts.push(value),
                other => panic!("expected close, got {other:?}"),
            }
        }
    }

    async fn start(&mut self) {
        self.send_json(start_message(2, "away", Some(DEVICE_KEY))).await;
        assert_eq!(self.control().await, json!({"type": "ready", "protocol_version": 2}));
    }

    async fn reply(&mut self, turn: u64, frames: u64, finish: bool, end: bool) {
        assert_eq!(self.control().await, json!({"type": "output_start", "turn_id": turn, "output_id": turn}));
        for index in 0..frames {
            assert_eq!(self.receive_bytes().await, pcm());
            self.send_json(json!({"type": "audio_ack", "turn_id": turn, "output_id": turn, "frames": index + 1}))
                .await;
        }
        assert_eq!(
            self.control().await,
            json!({"type": "output_end", "turn_id": turn, "output_id": turn, "frames": frames,
                   "samples": frames * 320, "end_call": end})
        );
        if finish {
            self.send_json(json!({"type": "playback_done", "turn_id": turn, "output_id": turn,
                                  "frames": frames, "samples": frames * 320}))
                .await;
        }
    }

    async fn greeting(&mut self) {
        self.send_json(json!({"type": "call_started", "turn_id": 0})).await;
        self.reply(0, 2, true, false).await;
        assert_eq!(self.control().await, json!({"type": "listen", "turn_id": 1}));
    }

    async fn input_turn(&mut self, turn: u64, frames: u64, reason: Value) {
        self.send_json(json!({"type": "input_start", "turn_id": turn})).await;
        for _ in 0..frames {
            self.send_bytes(pcm()).await;
        }
        self.send_json(json!({"type": "input_end", "turn_id": turn, "frames": frames,
                              "samples": frames * 320, "reason": reason}))
            .await;
    }
}

fn start_message(protocol_version: u8, mode: &str, device_key: Option<&str>) -> Value {
    let mut message = json!({"type": "start", "protocol_version": protocol_version,
                             "visit_id": uuid::Uuid::new_v4().to_string(), "mode": mode});
    if let Some(key) = device_key {
        message["device_key"] = key.into();
    }
    message
}

fn speakers(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|row| row["speaker"].as_str().unwrap().to_string()).collect()
}

// ------------------------------------------------------------------------------------
// test_relay_v2.py
// ------------------------------------------------------------------------------------

#[tokio::test]
async fn two_turns_only_listen_after_physical_playback_and_save_history() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    let agent = h.factory.runtime().await;
    assert_eq!(agent.reply_count.load(Ordering::SeqCst), 0);
    ws.greeting().await;
    for turn in [1, 2] {
        ws.input_turn(turn, 2, json!("silence")).await;
        ws.reply(turn, 2, false, false).await;
        ws.send_json(json!({"type": "ping", "turn_id": turn, "seq": 7})).await;
        assert_eq!(ws.control().await, json!({"type": "pong", "turn_id": turn, "seq": 7}));
        assert!(!agent.played.load(Ordering::SeqCst));
        ws.send_json(json!({"type": "playback_done", "turn_id": turn, "output_id": turn, "frames": 2, "samples": 640}))
            .await;
        assert_eq!(ws.control().await, json!({"type": "listen", "turn_id": turn + 1}));
    }
    ws.send_json(json!({"type": "end"})).await;
    assert_eq!(ws.closed().await, Some(1000));
    let visit = h.visit().await;
    assert_eq!(*agent.recognized.lock().unwrap(), vec![pcm().repeat(2), pcm().repeat(2)]);
    assert!(agent.closed.load(Ordering::SeqCst));
    assert_eq!(speakers(&ws.transcripts), ["ai", "visitor", "ai", "visitor", "ai"]);
    assert_eq!(ws.transcripts[1]["text"], "宅配便です。");
    assert_eq!(speakers(visit["messages"].as_array().unwrap()), ["ai", "visitor", "ai", "visitor", "ai"]);
    assert_eq!(visit["mode"], "away");
    assert!(visit.get("end_reason").is_none());
    assert!(visit.get("outcome").is_none());
    // A home device gets the door agent with the mode's rules.
    assert_eq!(agent.config.house_rules, base_rules(Mode::Away, false));
    assert_eq!(agent.config.device_key, None);
}

#[tokio::test]
async fn final_reply_waits_for_playback_then_end_button() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.greeting().await;
    h.factory.runtime().await.end.store(true, Ordering::SeqCst);
    ws.input_turn(1, 2, json!("silence")).await;
    ws.reply(1, 2, false, true).await;
    ws.send_json(json!({"type": "ping", "turn_id": 1, "seq": 3})).await;
    assert_eq!(ws.control().await["type"], "pong");
    ws.send_json(json!({"type": "playback_done", "turn_id": 1, "output_id": 1, "frames": 2, "samples": 640})).await;
    assert_eq!(ws.control().await, json!({"type": "call_end", "turn_id": 1, "reason": "completed"}));
    ws.send_json(json!({"type": "call_ended", "turn_id": 1})).await;
    assert_eq!(ws.closed().await, Some(1000));
}

#[tokio::test]
async fn greeting_end_call_is_never_set_on_turn_zero() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    h.factory.runtime().await.end.store(true, Ordering::SeqCst);
    ws.greeting().await; // output_end carries end_call=false and the call continues
}

#[tokio::test]
async fn no_reply_has_no_fabricated_audio_and_resumes() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.greeting().await;
    h.factory.runtime().await.no_reply.store(true, Ordering::SeqCst);
    ws.input_turn(1, 2, json!("silence")).await;
    assert_eq!(ws.control().await, json!({"type": "no_reply", "turn_id": 1}));
    assert_eq!(ws.control().await, json!({"type": "listen", "turn_id": 2}));
    ws.send_json(json!({"type": "cancel"})).await;
    assert_eq!(ws.closed().await, Some(1000));
}

#[tokio::test]
async fn rejects_state_and_generation_mismatch() {
    for payload in [
        json!({"type": "input_start", "turn_id": 0}),
        json!({"type": "input_end", "turn_id": 1, "frames": 0, "samples": 0, "reason": "silence"}),
        json!({"type": "playback_done", "turn_id": 1, "output_id": 1, "frames": 2, "samples": 640}),
    ] {
        let h = harness().await;
        let mut ws = h.connect().await;
        ws.start().await;
        ws.greeting().await;
        ws.send_json(payload.clone()).await;
        assert_eq!(ws.control().await["type"], "error", "{payload}");
    }
}

#[tokio::test]
async fn input_end_validates_exact_consumed_audio() {
    for (frames, samples, reason) in [(1, 320, "silence"), (2, 639, "silence"), (2, 640, "max_duration"), (2, 640, "other")] {
        let h = harness().await;
        let mut ws = h.connect().await;
        ws.start().await;
        ws.greeting().await;
        ws.send_json(json!({"type": "input_start", "turn_id": 1})).await;
        ws.send_bytes(pcm()).await;
        ws.send_bytes(pcm()).await;
        ws.send_json(json!({"type": "input_end", "turn_id": 1, "frames": frames, "samples": samples, "reason": reason}))
            .await;
        assert_eq!(ws.control().await["type"], "error");
        assert!(h.factory.runtime().await.recognized.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn accepts_exact_thirty_seconds_and_rejects_overrun() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.greeting().await;
    ws.input_turn(1, 1500, json!("max_duration")).await;
    ws.reply(1, 2, true, false).await;
    assert_eq!(ws.control().await["turn_id"], 2);
    ws.send_json(json!({"type": "input_start", "turn_id": 2})).await;
    for _ in 0..1501 {
        ws.send_bytes(pcm()).await;
    }
    assert_eq!(ws.control().await["code"], "input_limit");
    let agent = h.factory.runtime().await;
    let recognized = agent.recognized.lock().unwrap();
    assert_eq!(recognized.len(), 1);
    assert_eq!(recognized[0].len(), 960_000);
}

#[tokio::test]
async fn pcm_is_forbidden_while_the_device_is_playing() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.send_json(json!({"type": "call_started", "turn_id": 0})).await;
    ws.reply(0, 2, false, false).await;
    ws.send_bytes(pcm()).await;
    assert_eq!(ws.control().await["code"], "invalid_audio");
    assert_eq!(ws.closed().await, Some(1008));
    h.settle().await;
    assert!(h.factory.runtime().await.closed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn large_output_is_bounded_by_ack_window_but_keepalive_works() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    // The XIAO holds 48 acknowledged plus 16 unacknowledged frames (its 64-frame queue).
    h.factory.runtime().await.frames.store(21, Ordering::SeqCst);
    ws.send_json(json!({"type": "call_started", "turn_id": 0})).await;
    assert_eq!(ws.control().await["type"], "output_start");
    for _ in 0..16 {
        assert_eq!(ws.receive_bytes().await, pcm());
    }
    ws.send_json(json!({"type": "ping", "turn_id": 0, "seq": 1})).await;
    assert_eq!(ws.control().await["type"], "pong");
    ws.send_json(json!({"type": "audio_ack", "turn_id": 0, "output_id": 0, "frames": 16})).await;
    for _ in 0..5 {
        assert_eq!(ws.receive_bytes().await, pcm());
    }
    assert_eq!(ws.control().await["frames"], 21);
    ws.send_json(json!({"type": "cancel"})).await;
    assert_eq!(ws.closed().await, Some(1000));
    h.settle().await;
    assert!(h.factory.runtime().await.closed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn ack_window_timeout_is_a_voice_processing_failure() {
    let timings = Timings { ack_wait: Duration::from_millis(50), ..Timings::default() };
    let h = harness_with(timings, &[]).await;
    let mut ws = h.connect().await;
    ws.start().await;
    h.factory.runtime().await.frames.store(17, Ordering::SeqCst);
    ws.send_json(json!({"type": "call_started", "turn_id": 0})).await;
    assert_eq!(ws.control().await["type"], "output_start");
    for _ in 0..16 {
        ws.receive_bytes().await;
    }
    assert_eq!(
        ws.control().await,
        json!({"type": "error", "code": "agent_unavailable", "message": "Voice processing failed."})
    );
    assert_eq!(ws.closed().await, Some(1011));
}

#[tokio::test]
async fn unacknowledged_playback_done_is_rejected() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.send_json(json!({"type": "call_started", "turn_id": 0})).await;
    assert_eq!(ws.control().await["type"], "output_start");
    ws.receive_bytes().await;
    ws.receive_bytes().await;
    ws.control().await;
    ws.send_json(json!({"type": "playback_done", "turn_id": 0, "output_id": 0, "frames": 2, "samples": 640})).await;
    assert_eq!(ws.control().await["code"], "invalid_playback");
}

#[test]
fn call_start_deadline_outlasts_the_device_side_wait() {
    // M5 TCP connect 10 s + HELLO/READY 10 s + PING/PONG 5 s + up to 65 s for CALL_STARTED.
    let device_worst_case = Duration::from_secs(10 + 10 + 5 + 65);
    assert!(Timings::default().call_start >= device_worst_case + Duration::from_secs(5));
}

#[tokio::test]
async fn ready_arms_the_call_start_deadline() {
    let timings = Timings { call_start: Duration::from_millis(50), ..Timings::default() };
    let h = harness_with(timings, &[]).await;
    let mut ws = h.connect().await;
    ws.send_json(start_message(2, "away", Some(DEVICE_KEY))).await;
    assert_eq!(ws.control().await, json!({"type": "ready", "protocol_version": 2}));
    assert_eq!(
        ws.control().await,
        json!({"type": "error", "code": "time_limit", "message": "Conversation or state deadline expired."})
    );
    assert_eq!(ws.closed().await, Some(1008));
}

#[tokio::test]
async fn transcripts_are_bounded_on_the_wire_and_full_in_history() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    let long = "😀".repeat(500);
    *h.factory.runtime().await.text.lock().unwrap() = long.clone();
    ws.greeting().await;
    ws.input_turn(1, 2, json!("silence")).await;
    ws.reply(1, 2, true, false).await;
    ws.control().await;
    ws.send_json(json!({"type": "end"})).await;
    ws.closed().await;
    let sent = ws.transcripts.iter().find(|row| row["speaker"] == "visitor").unwrap()["text"].as_str().unwrap().to_string();
    assert!(long.starts_with(&sent) && !sent.is_empty() && sent.chars().count() < 120);
    let visit = h.visit().await;
    assert_eq!(visit["messages"][1]["text"], long);
}

#[tokio::test]
async fn invalid_start_generation_keeps_wire_error_and_closes_agent() {
    for turn in [json!(true), json!(-1), json!(1.0), json!("0"), json!(null), json!(1)] {
        let h = harness().await;
        let mut ws = h.connect().await;
        ws.start().await;
        ws.send_json(json!({"type": "call_started", "turn_id": turn})).await;
        assert_eq!(
            ws.control().await,
            json!({"type": "error", "code": "invalid_message", "message": "Invalid turn_id."})
        );
        assert_eq!(ws.closed().await, Some(1008));
        h.settle().await;
        assert!(h.factory.runtime().await.closed.load(Ordering::SeqCst));
        assert!(h.visits.lock().unwrap().is_empty(), "no visit before the call was answered");
    }
}

#[tokio::test]
async fn empty_input_with_malformed_reason_keeps_input_boundary_error() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.greeting().await;
    ws.input_turn(1, 0, json!([])).await;
    assert_eq!(
        ws.control().await,
        json!({"type": "error", "code": "invalid_input_end", "message": "Invalid input boundary."})
    );
    assert_eq!(ws.closed().await, Some(1008));
    let visit = h.visit().await;
    assert!(h.factory.runtime().await.closed.load(Ordering::SeqCst));
    // end_code "invalid_input_end" is saved as the generic safe ending.
    assert_eq!(visit["end_reason"], "safe");
}

#[tokio::test]
async fn staff_handoff_is_saved_as_escalated() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.greeting().await;
    h.factory.runtime().await.staff.store(true, Ordering::SeqCst);
    ws.send_json(json!({"type": "cancel"})).await;
    ws.closed().await;
    assert_eq!(h.visit().await["outcome"], "escalated");
}

#[tokio::test]
async fn invalid_control_json_is_rejected() {
    for text in ["{", "[]"] {
        let h = harness().await;
        let mut ws = h.connect().await;
        ws.start().await;
        ws.send_text(text).await;
        assert_eq!(
            ws.control().await,
            json!({"type": "error", "code": "invalid_message", "message": "Expected a JSON object."})
        );
        assert_eq!(ws.closed().await, Some(1008));
    }
}

// ------------------------------------------------------------------------------------
// test_relay.py: start message, authentication, device settings
// ------------------------------------------------------------------------------------

#[tokio::test]
async fn relay_rejects_missing_or_invalid_key() {
    let h = harness().await;
    for authorization in [None, Some("Bearer invalid")] {
        assert!(h.connect_with(authorization).await.is_err());
    }
    assert!(h.factory.runtimes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn relay_rejects_invalid_start() {
    let base = start_message(2, "omakase", Some(DEVICE_KEY));
    let mut cases = Vec::new();
    for (key, value) in [("mode", json!("off")), ("visit_id", json!("not-a-uuid")), ("device_key", json!("")),
                         ("device_key", json!("key with spaces"))] {
        let mut start = base.clone();
        start[key] = value;
        cases.push(start.to_string());
    }
    let mut without_mode = base.clone();
    without_mode.as_object_mut().unwrap().remove("mode");
    cases.push(without_mode.to_string());
    for case in cases {
        let h = harness().await;
        let mut ws = h.connect().await;
        ws.send_text(&case).await;
        assert_eq!(
            ws.control().await,
            json!({"type": "error", "code": "invalid_start", "message": "開始の JSON の形が違います。"})
        );
        assert_eq!(ws.closed().await, Some(1008));
        assert!(h.factory.runtimes.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn binary_start_is_invalid() {
    let h = harness().await;
    let mut ws = h.connect().await;
    ws.send_bytes(pcm()).await;
    assert_eq!(ws.control().await["code"], "invalid_start");
}

#[tokio::test]
async fn relay_times_out_without_start() {
    let h = harness_with(Timings::default(), &[("DOOR_RELAY_START_TIMEOUT_SECONDS", "0.05")]).await;
    let mut ws = h.connect().await;
    assert_eq!(
        ws.control().await,
        json!({"type": "error", "code": "start_timeout", "message": "開始の JSON が届きません。"})
    );
    assert_eq!(ws.closed().await, Some(1008));
}

#[tokio::test]
async fn protocol_v1_is_not_available_yet() {
    let h = harness().await;
    let mut ws = h.connect().await;
    let mut start = start_message(2, "normal", Some(DEVICE_KEY));
    start.as_object_mut().unwrap().remove("protocol_version");
    ws.send_json(start).await;
    assert_eq!(
        ws.control().await,
        json!({"type": "error", "code": "agent_unavailable", "message": "音声エージェントを開始できません。"})
    );
    assert_eq!(ws.closed().await, Some(1011));
}

#[tokio::test]
async fn relay_limits_concurrent_sessions() {
    let h = harness_with(Timings::default(), &[("DOOR_MAX_RELAY_SESSIONS", "1")]).await;
    let mut first = h.connect().await;
    first.start().await;
    let mut second = h.connect().await;
    assert_eq!(second.control().await["code"], "busy");
    assert_eq!(second.closed().await, Some(1013));
    first.send_json(json!({"type": "end"})).await;
    assert_eq!(first.closed().await, Some(1000));
}

#[tokio::test]
async fn shop_device_gets_reception_with_its_key() {
    let h = harness().await;
    let shop = ShopProfile { name: "ネイルサロン架空".into(), greeting: "いらっしゃいませ。".into(), ..Default::default() };
    *h.services.device.lock().unwrap() =
        Some(DeviceSettings { house: HouseSettings::default(), shop: Some(shop.clone()), paired: true, mode: None });
    let mut ws = h.connect().await;
    ws.start().await;
    let agent = h.factory.runtime().await;
    assert_eq!(agent.config.device_key.as_deref(), Some(DEVICE_KEY));
    assert_eq!(agent.config.shop, Some(shop));
    assert_eq!(*h.services.settings_keys.lock().unwrap(), [DEVICE_KEY]);
}

#[tokio::test]
async fn house_settings_shape_the_rules() {
    let h = harness().await;
    *h.services.device.lock().unwrap() = Some(DeviceSettings {
        house: HouseSettings { away_leave_at_door: true, extra_instructions: "宗教の勧誘も断ってください。".into() },
        shop: None,
        paired: true,
        mode: None,
    });
    let mut ws = h.connect().await;
    ws.start().await;
    let rules = h.factory.runtime().await.config.house_rules.clone();
    assert!(rules.starts_with(&base_rules(Mode::Away, true)));
    assert!(rules.ends_with("宗教の勧誘も断ってください。"));
}

#[tokio::test]
async fn unpaired_diagnostic_device_gets_the_door_agent_without_history() {
    let h = harness().await;
    *h.services.device.lock().unwrap() =
        Some(DeviceSettings { house: HouseSettings::default(), shop: Some(ShopProfile::default()), paired: true, mode: None });
    let mut ws = h.connect().await;
    ws.send_json(start_message(2, "normal", Some("e84-diagnostic-unpaired"))).await;
    assert_eq!(ws.control().await["type"], "ready");
    ws.greeting().await;
    ws.send_json(json!({"type": "end"})).await;
    ws.closed().await;
    h.settle().await;
    assert!(h.services.settings_keys.lock().unwrap().is_empty());
    let agent = h.factory.runtime().await;
    assert_eq!(agent.config.device_key, None);
    assert_eq!(agent.config.shop, None);
    assert_eq!(agent.config.house_rules, base_rules(Mode::Normal, false));
    assert!(h.visits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn production_relay_accepts_authenticated_clients_over_tailnet() {
    let h = harness_with(
        Timings::default(),
        &[
            ("DOOR_ENV", "production"),
            ("DOOR_ALLOW_TAILNET_HTTP", "1"),
            ("LIVEKIT_API_KEY", "prod-livekit-key"),
            ("LIVEKIT_API_SECRET", "prod-livekit-secret-with-32-bytes-minimum"),
            ("LIVEKIT_URL", "http://livekit:7880"),
            ("LIVEKIT_WS_URL", "ws://livekit:7880"),
            ("DOOR_ALLOWED_HOSTS", "127.0.0.1,localhost"),
            ("DOOR_PUBLIC_API_HOSTNAME", "localhost"),
            ("DOOR_SUPABASE_URL", "https://example.supabase.co"),
        ],
    )
    .await;
    let mut ws = h.connect().await;
    ws.start().await;
    ws.send_json(json!({"type": "end"})).await;
    assert_eq!(ws.closed().await, Some(1000));
}
