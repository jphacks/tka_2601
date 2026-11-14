//! Device-controlled turns on `/api/relay` (port of `relay/v2.py`).
//!
//! JSON control and raw PCM share one ordered socket. Only a completed, validated input is
//! submitted to ASR; only acknowledged physical playout releases a reply.
//!
//! The protocol state lives in [`Core`] and changes only through its synchronous methods,
//! which return what to send. [`serve_v2`] runs the receive loop and the model work
//! concurrently (Python's `asyncio.wait` over the receive task and the model task); the
//! model runs as its own task so it can keep sending audio while the loop handles
//! keepalives, acknowledgements and playback reports.

use std::sync::{Arc, Mutex, OnceLock, Weak};

use axum::extract::ws::{Message, WebSocket};
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use monban_policy::house_rules::build_house_rules;

use super::runtime::{config_for, OutputSink, RuntimeConfig, Timings, VoiceRuntime};
use super::{close_message, codes, json_text, Disconnected, RelayError, StartMessage, CLOSE_NORMAL};
use crate::app::AppState;
use crate::persistence::history::{utc_now_iso, Utterance, VisitRecord};

pub(crate) const FRAME_BYTES: usize = 640;
pub(crate) const MAX_INPUT_FRAMES: u64 = 1500;
pub(crate) const MAX_OUTPUT_SAMPLES: u64 = 16000 * 60;
pub(crate) const OUTPUT_WINDOW: u64 = 10;
const MAX_TURNS: u64 = 20;
const MAX_CONTROL_BYTES: usize = 1024;
const MAX_TRANSCRIPT_CHARS: usize = 120;
const MAX_TRANSCRIPT_EVENT_BYTES: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Preparing,
    Ready,
    Listening,
    Input,
    Processing,
    Playback,
    Played,
    Ending,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Preparing => "preparing",
            Phase::Ready => "ready",
            Phase::Listening => "listening",
            Phase::Input => "input",
            Phase::Processing => "processing",
            Phase::Playback => "playback",
            Phase::Played => "played",
            Phase::Ending => "ending",
        }
    }
}

/// What the receive loop must do after a message was applied to [`Core`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Continue,
    /// `cancel`, `end` or `call_ended`: close with 1000.
    Close,
    Send(Value),
    /// Start the model work: the greeting (`None`) or one recognized input.
    Generate(Option<Vec<u8>>),
    /// The acknowledged frame count or the playback state changed.
    Wake,
}

/// The protocol state of one call (`DeviceConversation`'s fields).
pub(crate) struct Core {
    pub(crate) phase: Phase,
    pub(crate) turn: u64,
    pcm: Vec<u8>,
    input_frames: u64,
    pcm_deadline: Option<Instant>,
    pub(crate) output_frames: u64,
    pub(crate) output_samples: u64,
    pub(crate) ack_frames: u64,
    pub(crate) output_ended: bool,
    pub(crate) end_call: bool,
    /// `None` is Python's `float("inf")`.
    pub(crate) deadline: Option<Instant>,
    pub(crate) call_deadline: Option<Instant>,
    pub(crate) utterances: Vec<Utterance>,
    pub(crate) answered_at: Option<String>,
    timings: Timings,
    max_session: std::time::Duration,
}

fn integer(payload: &Map<String, Value>, key: &str, expected: Option<u64>) -> Result<u64, RelayError> {
    // `type(value) is int and value >= 0`: booleans and floats are rejected.
    let value = match payload.get(key) {
        Some(Value::Number(number)) if number.is_u64() || number.is_i64() => number.as_u64(),
        _ => None,
    };
    match value {
        Some(value) if expected.is_none_or(|expected| expected == value) => Ok(value),
        _ => Err(RelayError::new(codes::INVALID_MESSAGE, format!("Invalid {key}."))),
    }
}

fn min_deadline(a: Option<Instant>, b: Option<Instant>) -> Option<Instant> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

impl Core {
    pub(crate) fn new(timings: Timings, max_session: std::time::Duration) -> Self {
        Self {
            phase: Phase::Preparing,
            turn: 0,
            pcm: Vec::new(),
            input_frames: 0,
            pcm_deadline: None,
            output_frames: 0,
            output_samples: 0,
            ack_frames: 0,
            output_ended: false,
            end_call: false,
            deadline: None,
            call_deadline: None,
            utterances: Vec::new(),
            answered_at: None,
            timings,
            max_session,
        }
    }

    pub(crate) fn effective_deadline(&self) -> Option<Instant> {
        let deadline = min_deadline(self.deadline, self.call_deadline);
        if self.phase == Phase::Input {
            min_deadline(deadline, self.pcm_deadline)
        } else {
            deadline
        }
    }

    pub(crate) fn mark_ready(&mut self, now: Instant) -> Value {
        self.phase = Phase::Ready;
        self.deadline = Some(now + self.timings.call_start);
        json!({"type": "ready", "protocol_version": 2})
    }

    fn generate(&mut self, now: Instant, pcm: Option<Vec<u8>>) -> Action {
        self.phase = Phase::Processing;
        self.output_frames = 0;
        self.output_samples = 0;
        self.ack_frames = 0;
        self.output_ended = false;
        self.end_call = false;
        self.deadline = Some(now + self.timings.response);
        Action::Generate(pcm)
    }

    pub(crate) fn listen(&mut self, now: Instant) -> Value {
        if self.turn >= MAX_TURNS {
            return self.hangup(now, "turn_limit");
        }
        self.turn += 1;
        self.phase = Phase::Listening;
        self.deadline = Some(now + self.timings.listen);
        json!({"type": "listen", "turn_id": self.turn})
    }

    pub(crate) fn hangup(&mut self, now: Instant, reason: &str) -> Value {
        self.phase = Phase::Ending;
        self.deadline = Some(now + self.timings.end);
        // Allow the physical end-button operation to complete after the call limit.
        self.call_deadline = None;
        json!({"type": "call_end", "turn_id": self.turn, "reason": reason})
    }

    /// One binary message: input PCM.
    pub(crate) fn on_binary(&mut self, now: Instant, pcm: &[u8]) -> Result<Action, RelayError> {
        if self.phase != Phase::Input || pcm.len() != FRAME_BYTES {
            return Err(RelayError::new(
                codes::INVALID_AUDIO,
                "Input PCM must be 640 bytes during an input turn.",
            ));
        }
        if self.input_frames >= MAX_INPUT_FRAMES {
            return Err(RelayError::new(codes::INPUT_LIMIT, "Input audio exceeds 30 seconds."));
        }
        if self.input_frames == 0 {
            // The 30-second recording clock starts with the first actual speech frame.
            self.deadline = Some(now + self.timings.input_recording);
        }
        self.pcm.extend_from_slice(pcm);
        self.input_frames += 1;
        self.pcm_deadline = Some(now + self.timings.input_frame_gap);
        Ok(Action::Continue)
    }

    /// One text message: control JSON.
    pub(crate) fn on_text(&mut self, now: Instant, text: &str) -> Result<Action, RelayError> {
        if text.len() > MAX_CONTROL_BYTES {
            return Err(RelayError::new(codes::INVALID_MESSAGE, "Control message is too large."));
        }
        let Ok(Value::Object(payload)) = serde_json::from_str::<Value>(text) else {
            return Err(RelayError::new(codes::INVALID_MESSAGE, "Expected a JSON object."));
        };
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let has_kind = |name: &str| payload.get("type").and_then(Value::as_str) == Some(name);
        if has_kind("cancel") || has_kind("end") {
            return Ok(Action::Close);
        }
        if has_kind("ping") || has_kind("pong") {
            let ping_turn = integer(&payload, "turn_id", None)?;
            let seq = integer(&payload, "seq", None)?;
            if ping_turn > self.turn || ping_turn < self.turn.saturating_sub(1) {
                return Err(RelayError::new(codes::INVALID_MESSAGE, "Stale keepalive generation."));
            }
            if kind == "ping" {
                return Ok(Action::Send(json!({"type": "pong", "turn_id": ping_turn, "seq": seq})));
            }
            return Ok(Action::Continue);
        }
        if has_kind("call_started") && self.phase == Phase::Ready {
            tracing::info!("relay v2 physical call started");
            integer(&payload, "turn_id", Some(0))?;
            self.answered_at = Some(utc_now_iso());
            self.call_deadline = Some(now + self.max_session);
            return Ok(self.generate(now, None));
        }
        integer(&payload, "turn_id", Some(self.turn))?;
        let is = |name: &str| has_kind(name);
        if is("input_start") && self.phase == Phase::Listening {
            self.phase = Phase::Input;
            self.pcm.clear();
            self.input_frames = 0;
            // input_start arms the device's VAD. Its first speech frame may arrive much
            // later, so the 30-second recording clock has not started yet.
            let input_deadline = now + self.timings.input_start;
            self.pcm_deadline = Some(input_deadline);
            self.deadline = Some(input_deadline);
            Ok(Action::Continue)
        } else if is("input_end") && self.phase == Phase::Input {
            integer(&payload, "frames", Some(self.input_frames))?;
            integer(&payload, "samples", Some(self.input_frames * 320))?;
            let invalid = || RelayError::new(codes::INVALID_INPUT_END, "Invalid input boundary.");
            if self.input_frames == 0 {
                return Err(invalid());
            }
            let reason = payload.get("reason").and_then(Value::as_str);
            let valid_reason = matches!(reason, Some("silence") | Some("max_duration"));
            let truncated_max_duration =
                reason == Some("max_duration") && self.input_frames != MAX_INPUT_FRAMES;
            if !valid_reason || truncated_max_duration {
                return Err(invalid());
            }
            // The single receive loop consumed all binary messages before this JSON.
            let pcm = std::mem::take(&mut self.pcm);
            Ok(self.generate(now, Some(pcm)))
        } else if is("audio_ack") && matches!(self.phase, Phase::Processing | Phase::Playback) {
            integer(&payload, "output_id", Some(self.turn))?;
            let frames = integer(&payload, "frames", None)?;
            if frames < self.ack_frames || frames > self.output_frames {
                return Err(RelayError::new(codes::INVALID_ACK, "Audio acknowledgement is out of range."));
            }
            self.ack_frames = frames;
            Ok(Action::Wake)
        } else if is("playback_done") && self.phase == Phase::Playback {
            integer(&payload, "output_id", Some(self.turn))?;
            integer(&payload, "frames", Some(self.output_frames))?;
            integer(&payload, "samples", Some(self.output_samples))?;
            if !self.output_ended || self.ack_frames != self.output_frames {
                return Err(RelayError::new(
                    codes::INVALID_PLAYBACK,
                    "All output must be acknowledged before playback completion.",
                ));
            }
            self.phase = Phase::Played;
            self.deadline = Some(now + self.timings.played_to_next);
            Ok(Action::Wake)
        } else if is("call_ended") && self.phase == Phase::Ending {
            Ok(Action::Close)
        } else {
            Err(RelayError::new(codes::INVALID_STATE, "Message is invalid for the current turn."))
        }
    }
}

/// `json.dumps(value)` with `ensure_ascii=True`, for measuring the device's buffer limit.
fn py_ascii_quote(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(ch),
            _ => {
                let mut units = [0u16; 2];
                for unit in ch.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
}

fn transcript_event_ascii_len(speaker: &str, text: &str) -> usize {
    let mut out = String::from("{\"type\": \"transcript\", \"speaker\": ");
    py_ascii_quote(speaker, &mut out);
    out.push_str(", \"text\": ");
    py_ascii_quote(text, &mut out);
    out.push('}');
    out.len()
}

/// The transcript text sent to the device: at most 120 characters, and the event fits the
/// device's 1024-byte control buffer even when every character is escaped. History keeps
/// the full text.
pub(crate) fn bounded_transcript_text(speaker: &str, text: &str) -> String {
    let mut chars: Vec<char> = text.chars().take(MAX_TRANSCRIPT_CHARS).collect();
    while transcript_event_ascii_len(speaker, &chars.iter().collect::<String>()) > MAX_TRANSCRIPT_EVENT_BYTES {
        chars.pop();
    }
    chars.into_iter().collect()
}

/// Why a conversation ended early.
enum Failure {
    Relay(RelayError),
    Disconnected,
    /// Any other failure (Python's generic `Exception`), reported as `agent_unavailable`.
    Other(String),
}

impl From<RelayError> for Failure {
    fn from(error: RelayError) -> Self {
        Failure::Relay(error)
    }
}

impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        if let Some(relay) = error.downcast_ref::<RelayError>() {
            return Failure::Relay(relay.clone());
        }
        if error.downcast_ref::<Disconnected>().is_some() {
            return Failure::Disconnected;
        }
        Failure::Other(error.to_string())
    }
}

/// State shared by the receive loop, the model task and the output sink.
struct Shared {
    sender: tokio::sync::Mutex<SplitSink<WebSocket, Message>>,
    core: Mutex<Core>,
    changed: Notify,
    runtime: OnceLock<Arc<dyn VoiceRuntime>>,
    timings: Timings,
}

#[derive(Debug, thiserror::Error)]
#[error("TimeoutError: {0}")]
struct Timeout(&'static str);

impl Shared {
    fn core(&self) -> std::sync::MutexGuard<'_, Core> {
        self.core.lock().expect("relay state lock")
    }

    /// Send under the send lock with Python's five-second bound.
    async fn send(&self, message: Message) -> anyhow::Result<()> {
        let mut sender = self.sender.lock().await;
        match tokio::time::timeout(self.timings.send, sender.send(message)).await {
            Err(_) => Err(Timeout("websocket send").into()),
            Ok(Err(_)) => Err(Disconnected.into()),
            Ok(Ok(())) => Ok(()),
        }
    }

    async fn send_json(&self, value: Value) -> anyhow::Result<()> {
        self.send(json_text(&value)).await
    }

    /// Wait until `ready` holds, re-checking after every state change.
    async fn wait_until(&self, mut ready: impl FnMut(&Core) -> Option<anyhow::Result<()>>) -> anyhow::Result<()> {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(result) = ready(&self.core()) {
                return result;
            }
            notified.await;
        }
    }
}

/// The [`OutputSink`] the runtime writes to (`write_audio`, `finish_audio`, `transcript`
/// and the playout wait of `DeviceConversation` / `DeviceAudioOutput`).
struct DeviceSink {
    shared: Weak<Shared>,
}

impl DeviceSink {
    fn shared(&self) -> anyhow::Result<Arc<Shared>> {
        self.shared.upgrade().ok_or_else(|| Disconnected.into())
    }
}

#[async_trait::async_trait]
impl OutputSink for DeviceSink {
    async fn write_audio(&self, pcm: Vec<u8>) -> anyhow::Result<()> {
        let shared = self.shared()?;
        {
            let core = shared.core();
            let output_open = core.phase == Phase::Processing && !core.output_ended;
            let valid_pcm = !pcm.is_empty() && pcm.len().is_multiple_of(2) && pcm.len() <= FRAME_BYTES;
            if !output_open || !valid_pcm {
                return Err(RelayError::server(codes::INVALID_OUTPUT, "Invalid agent audio boundary.").into());
            }
            if core.output_samples + (pcm.len() / 2) as u64 > MAX_OUTPUT_SAMPLES {
                return Err(RelayError::server(codes::OUTPUT_LIMIT, "Agent audio exceeds 60 seconds.").into());
            }
        }
        let window = shared.wait_until(|core| {
            (core.output_frames - core.ack_frames < OUTPUT_WINDOW).then_some(Ok(()))
        });
        tokio::time::timeout(shared.timings.ack_wait, window)
            .await
            .map_err(|_| Timeout("audio acknowledgement window"))??;
        let output_start = {
            let core = shared.core();
            (core.output_frames == 0)
                .then(|| json!({"type": "output_start", "turn_id": core.turn, "output_id": core.turn}))
        };
        if let Some(output_start) = output_start {
            shared.send_json(output_start).await?;
        }
        {
            let mut core = shared.core();
            core.output_frames += 1;
            core.output_samples += (pcm.len() / 2) as u64;
        }
        shared.send(Message::Binary(pcm.into())).await
    }

    async fn finish_audio(&self) -> anyhow::Result<()> {
        let shared = self.shared()?;
        let turn = {
            let core = shared.core();
            if core.phase != Phase::Processing || core.output_ended || core.output_frames == 0 {
                return Err(RelayError::server(codes::INVALID_OUTPUT, "Invalid agent output completion.").into());
            }
            core.turn
        };
        let end_call = turn > 0 && shared.runtime.get().is_some_and(|runtime| runtime.end_after_reply());
        let output_end = {
            let mut core = shared.core();
            core.end_call = end_call;
            // State is updated before send: an immediate peer acknowledgement is valid.
            core.output_ended = true;
            core.phase = Phase::Playback;
            core.deadline = Some(Instant::now() + shared.timings.playback);
            json!({
                "type": "output_end", "turn_id": core.turn, "output_id": core.turn,
                "frames": core.output_frames, "samples": core.output_samples, "end_call": core.end_call,
            })
        };
        shared.send_json(output_end).await
    }

    async fn wait_played(&self) -> anyhow::Result<()> {
        let shared = self.shared()?;
        shared
            .wait_until(|core| {
                if !core.output_ended {
                    return Some(Err(anyhow::anyhow!("playout cannot finish before audio flush")));
                }
                (core.phase == Phase::Played).then_some(Ok(()))
            })
            .await
    }

    async fn transcript(&self, speaker: &str, text: &str) -> anyhow::Result<()> {
        let shared = self.shared()?;
        shared.core().utterances.push(Utterance::now(speaker, text));
        let bounded = bounded_transcript_text(speaker, text);
        shared.send_json(json!({"type": "transcript", "speaker": speaker, "text": bounded})).await
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

type Model = Option<JoinHandle<anyhow::Result<()>>>;

fn spawn_model(runtime: Arc<dyn VoiceRuntime>, pcm: Option<Vec<u8>>) -> JoinHandle<anyhow::Result<()>> {
    tokio::spawn(async move {
        match pcm {
            None => runtime.reply(None).await,
            Some(pcm) => {
                let text = runtime.recognize(pcm).await?;
                if text.is_empty() {
                    Ok(())
                } else {
                    runtime.reply(Some(text)).await
                }
            }
        }
    })
}

async fn run(
    state: &AppState,
    shared: &Arc<Shared>,
    receiver: &mut SplitStream<WebSocket>,
    start: &StartMessage,
    model: &mut Model,
) -> Result<(), Failure> {
    let Some(config) = config_for(state) else {
        return Err(Failure::Other("no voice runtime is registered".into()));
    };
    let device = match &start.device_key {
        Some(device_key) => state.services.fetch_device_settings(device_key).await,
        None => None,
    };
    let house_rules = build_house_rules(
        start.mode,
        device.as_ref().map(|device| &device.house),
        state.settings.max_house_rules_chars,
    );
    let shop = device.and_then(|device| device.shop);
    let runtime = config.factory.create(
        RuntimeConfig {
            house_rules,
            device_key: shop.as_ref().and(start.device_key.clone()),
            shop,
        },
        Arc::new(DeviceSink { shared: Arc::downgrade(shared) }),
    );
    let _ = shared.runtime.set(runtime.clone());
    tokio::time::timeout(shared.timings.runtime_start, runtime.start())
        .await
        .map_err(|_| Failure::Other("TimeoutError: runtime start".into()))??;
    let ready = shared.core().mark_ready(Instant::now());
    shared.send_json(ready).await?;

    loop {
        let deadline = shared.core().effective_deadline();
        enum Event {
            Message(Option<Result<Message, axum::Error>>),
            Model(Result<anyhow::Result<()>, tokio::task::JoinError>),
            Deadline,
        }
        let event = tokio::select! {
            biased;
            message = receiver.next() => Event::Message(message),
            result = async {
                match model.as_mut() {
                    Some(handle) => handle.await,
                    None => std::future::pending().await,
                }
            } => Event::Model(result),
            _ = sleep_until(deadline) => Event::Deadline,
        };
        match event {
            Event::Deadline => {
                return Err(RelayError::new(codes::TIME_LIMIT, "Conversation or state deadline expired.").into())
            }
            Event::Message(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return Err(Failure::Disconnected),
            Event::Message(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            Event::Message(Some(Ok(message))) => {
                let now = Instant::now();
                let action = match &message {
                    Message::Binary(pcm) => shared.core().on_binary(now, pcm)?,
                    Message::Text(text) => shared.core().on_text(now, text.as_str())?,
                    _ => Action::Continue,
                };
                match action {
                    Action::Continue => {}
                    Action::Close => {
                        let _ = shared.send(close_message(CLOSE_NORMAL)).await;
                        return Ok(());
                    }
                    Action::Send(payload) => shared.send_json(payload).await?,
                    Action::Generate(pcm) => {
                        if let Some(previous) = model.take() {
                            previous.abort();
                        }
                        *model = Some(spawn_model(runtime.clone(), pcm));
                    }
                    Action::Wake => shared.changed.notify_waiters(),
                }
            }
            Event::Model(result) => {
                *model = None;
                result.map_err(|error| Failure::Other(format!("model task failed: {error}")))??;
                let now = Instant::now();
                let next = {
                    let mut core = shared.core();
                    if core.output_frames == 0 {
                        if core.turn == 0 {
                            return Err(
                                RelayError::server(codes::EMPTY_GREETING, "Greeting audio is unavailable.").into()
                            );
                        }
                        vec![json!({"type": "no_reply", "turn_id": core.turn}), core.listen(now)]
                    } else if core.phase != Phase::Played {
                        return Err(RelayError::server(
                            codes::INVALID_OUTPUT,
                            "Agent completed before physical playout.",
                        )
                        .into());
                    } else if core.end_call {
                        vec![core.hangup(now, "completed")]
                    } else {
                        vec![core.listen(now)]
                    }
                };
                for payload in next {
                    shared.send_json(payload).await?;
                }
            }
        }
    }
}

/// Run one protocol v2 conversation and save its history.
pub(super) async fn serve_v2(state: AppState, socket: WebSocket, start: StartMessage) {
    let config = config_for(&state);
    let timings = config.as_ref().map(|config| config.timings).unwrap_or_default();
    let (sender, mut receiver) = socket.split();
    let chimed_at = utc_now_iso();
    let shared = Arc::new(Shared {
        sender: tokio::sync::Mutex::new(sender),
        core: Mutex::new(Core::new(
            timings,
            std::time::Duration::from_secs_f64(state.settings.relay_max_session_seconds),
        )),
        changed: Notify::new(),
        runtime: OnceLock::new(),
        timings,
    });
    let mut model: Model = None;
    let result = run(&state, &shared, &mut receiver, &start, &mut model).await;
    // Stop the model first so no reply audio follows the error message.
    if let Some(handle) = model.take() {
        handle.abort();
        let _ = handle.await;
    }
    let end_code: Option<&'static str> = match result {
        Ok(()) => None,
        Err(failure) => {
            let error = match failure {
                Failure::Relay(error) => Some(error),
                Failure::Disconnected => None,
                Failure::Other(reason) => {
                    tracing::warn!("relay v2 failed: {reason}");
                    Some(RelayError::server(codes::AGENT_UNAVAILABLE, "Voice processing failed."))
                }
            };
            match error {
                Some(error) => {
                    tracing::info!("relay v2 error code={} state={}", error.code, shared.core().phase.as_str());
                    let message = json!({"type": "error", "code": error.code, "message": error.message});
                    if shared.send_json(message).await.is_ok() {
                        let _ = shared.send(close_message(error.close_code)).await;
                    }
                    Some(error.code)
                }
                None => Some("disconnected"),
            }
        }
    };
    tracing::info!("relay v2 closed code={} state={}", end_code.unwrap_or("ended"), shared.core().phase.as_str());

    // Bounded cleanup: close the model clients and release the session's buffers.
    let runtime = shared.runtime.get().cloned();
    let cleanup = async {
        if let Some(runtime) = &runtime {
            runtime.close().await;
        }
        shared.core().pcm.clear();
    };
    if tokio::time::timeout(timings.cleanup, cleanup).await.is_err() {
        tracing::warn!("relay v2 cleanup timed out");
    }

    let (answered_at, utterances) = {
        let core = shared.core();
        (core.answered_at.clone(), core.utterances.clone())
    };
    if let (Some(device_key), Some(answered_at)) = (&start.device_key, answered_at) {
        let end_json = runtime
            .as_ref()
            .filter(|runtime| runtime.staff_requested())
            .map(|_| json!({"outcome": "escalated"}));
        state
            .history
            .write_visit(VisitRecord {
                device_key,
                visit_id: start.visit_id,
                mode: start.mode.as_str(),
                chimed_at: &chimed_at,
                answered_at: &answered_at,
                utterances: &utterances,
                end_code,
                end_json: end_json.as_ref(),
            })
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const PCM: [u8; 640] = [1; 640];

    fn core() -> Core {
        Core::new(Timings::default(), Duration::from_secs(120))
    }

    fn secs(later: Option<Instant>, from: Instant) -> f64 {
        later.unwrap().duration_since(from).as_secs_f64()
    }

    #[test]
    fn input_start_waits_for_first_speech_before_recording_deadline() {
        let mut call = core();
        call.phase = Phase::Listening;
        call.turn = 1;
        let before = Instant::now();
        assert_eq!(call.on_text(before, r#"{"type":"input_start","turn_id":1}"#), Ok(Action::Continue));
        assert_eq!(secs(call.deadline, before), 60.0);
        assert_eq!(call.pcm_deadline, call.deadline);
        let later = before + Duration::from_secs(20);
        assert_eq!(call.on_binary(later, &PCM), Ok(Action::Continue));
        assert_eq!(secs(call.deadline, later), 35.0);
        assert_eq!(secs(call.pcm_deadline, later), 5.0);
        assert_eq!(call.effective_deadline(), call.pcm_deadline);
    }

    #[test]
    fn turn_limit_hangs_up_with_current_generation() {
        let mut call = core();
        call.turn = 20;
        let message = call.listen(Instant::now());
        assert_eq!(message, json!({"type": "call_end", "turn_id": 20, "reason": "turn_limit"}));
        assert_eq!(call.turn, 20);
        assert_eq!(call.phase, Phase::Ending);
        assert_eq!(call.call_deadline, None);
    }

    #[test]
    fn integers_follow_pythons_exact_int_check() {
        let mut call = core();
        call.phase = Phase::Ready;
        for turn in ["true", "-1", "1.0", "\"0\"", "null", "1"] {
            let text = format!(r#"{{"type":"call_started","turn_id":{turn}}}"#);
            assert_eq!(
                call.on_text(Instant::now(), &text),
                Err(RelayError::new(codes::INVALID_MESSAGE, "Invalid turn_id.")),
                "{turn}"
            );
        }
        let action = call.on_text(Instant::now(), r#"{"type":"call_started","turn_id":0}"#).unwrap();
        assert_eq!(action, Action::Generate(None));
        assert_eq!(call.phase, Phase::Processing);
        assert!(call.answered_at.is_some());
    }

    #[test]
    fn keepalives_accept_the_current_and_previous_generation() {
        let mut call = core();
        call.turn = 3;
        let now = Instant::now();
        assert_eq!(
            call.on_text(now, r#"{"type":"ping","turn_id":2,"seq":9}"#),
            Ok(Action::Send(json!({"type": "pong", "turn_id": 2, "seq": 9})))
        );
        assert_eq!(call.on_text(now, r#"{"type":"pong","turn_id":3,"seq":1}"#), Ok(Action::Continue));
        for turn in [1, 4] {
            let text = format!(r#"{{"type":"ping","turn_id":{turn},"seq":1}}"#);
            assert_eq!(
                call.on_text(now, &text),
                Err(RelayError::new(codes::INVALID_MESSAGE, "Stale keepalive generation."))
            );
        }
    }

    #[test]
    fn control_messages_are_bounded_objects() {
        let mut call = core();
        let now = Instant::now();
        let large = format!(r#"{{"type":"ping","pad":"{}"}}"#, "x".repeat(1024));
        assert_eq!(
            call.on_text(now, &large),
            Err(RelayError::new(codes::INVALID_MESSAGE, "Control message is too large."))
        );
        for text in ["{", "[]", "1"] {
            assert_eq!(call.on_text(now, text), Err(RelayError::new(codes::INVALID_MESSAGE, "Expected a JSON object.")));
        }
        assert_eq!(call.on_text(now, r#"{"type":"cancel"}"#), Ok(Action::Close));
        assert_eq!(
            call.on_text(now, r#"{"type":"bogus","turn_id":0}"#),
            Err(RelayError::new(codes::INVALID_STATE, "Message is invalid for the current turn."))
        );
    }

    #[test]
    fn non_string_reason_is_an_input_boundary_error() {
        let mut call = core();
        call.phase = Phase::Input;
        call.turn = 1;
        let now = Instant::now();
        call.on_binary(now, &PCM).unwrap();
        assert_eq!(
            call.on_text(now, r#"{"type":"input_end","turn_id":1,"frames":1,"samples":320,"reason":[]}"#),
            Err(RelayError::new(codes::INVALID_INPUT_END, "Invalid input boundary."))
        );
    }

    #[test]
    fn transcript_event_is_bounded_and_keeps_a_prefix() {
        for text in ["荷物を玄関に置きました。".to_string(), "日".repeat(2000), "😀\\\n\"".repeat(1000)] {
            let bounded = bounded_transcript_text("visitor", &text);
            assert!(!bounded.is_empty());
            assert!(text.starts_with(&bounded));
            assert!(bounded.chars().count() <= 120);
            assert!(transcript_event_ascii_len("visitor", &bounded) <= 1024);
        }
        // 120 escaped "日" (six bytes each) still fit; 120 emoji (twelve each) do not.
        assert_eq!(bounded_transcript_text("visitor", &"日".repeat(2000)).chars().count(), 120);
        let overhead = transcript_event_ascii_len("visitor", "");
        let emoji = bounded_transcript_text("visitor", &"😀".repeat(200));
        assert_eq!(emoji.chars().count(), (1024 - overhead) / 12);
    }

    #[test]
    fn ascii_quote_matches_python() {
        // json.dumps("a\"\\\n\u0001é😀\x7f", ensure_ascii=True)
        let mut out = String::new();
        py_ascii_quote("a\"\\\n\u{1}é😀\u{7f}", &mut out);
        let u = |hex: &str| format!("{}u{hex}", '\\');
        let expected = format!(
            "\"a{bs}\"{bs}{bs}{bs}n{}{}{}{}{}\"",
            u("0001"),
            u("00e9"),
            u("d83d"),
            u("de00"),
            u("007f"),
            bs = '\\'
        );
        assert_eq!(out, expected);
    }
}
