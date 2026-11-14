//! Replays the Python oracle fixtures (`tests/fixtures/voice/*.json`, recorded by
//! `tools/voice_oracle/capture.py`) through the Rust v2 voice pipeline and compares the
//! upstream requests and the per-turn output (Issue #79).
//!
//! The stand-in upstream below answers exactly as `capture.py`'s `Recorder` does.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use axum::extract::{Multipart, Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use monban_backend::config::Settings;
use monban_backend::persistence::device_api::{py_isoformat, ShopProfile};
use monban_backend::reception::desk::today_range;
use monban_backend::relay::{OutputSink, RuntimeConfig, VoiceRuntime};
use monban_backend::voice::adapters::live_models;
use monban_backend::voice::runtime::DeviceRuntime;

// ---------------------------------------------------------------------------------------
// Stand-in upstream
// ---------------------------------------------------------------------------------------

struct Recorder {
    scenario: Value,
    rate: u32,
    requests: Mutex<Vec<Value>>,
    asr: Mutex<std::vec::IntoIter<Value>>,
    llm: Mutex<std::vec::IntoIter<Value>>,
    arrived: Mutex<Vec<String>>,
}

type Shared = Arc<Recorder>;

fn list(value: &Value, key: &str) -> Vec<Value> {
    value.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

impl Recorder {
    fn record(&self, method: &str, path: &str, query: Map<String, Value>, headers: &HeaderMap, body: Value) {
        let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
        let content_type = header("content-type").map(|v| v.split(';').next().unwrap_or("").trim().to_string());
        self.requests.lock().unwrap().push(json!({
            "method": method,
            "path": path,
            "query": query,
            "authorization": header("authorization"),
            "apikey": header("apikey"),
            "content_type": content_type.unwrap_or_else(|| "application/octet-stream".into()),
            "body": body,
        }));
    }

    fn reservations(&self) -> Vec<Value> {
        let (day, _) = today_range(Utc::now());
        let arrived = self.arrived.lock().unwrap();
        list(&self.scenario, "reservations")
            .iter()
            .map(|row| {
                let (hour, minute) = row["time"].as_str().unwrap().split_once(':').unwrap();
                let start = day + ChronoDuration::hours(hour.parse().unwrap()) + ChronoDuration::minutes(minute.parse().unwrap());
                let id = row["id"].as_str().unwrap().to_string();
                json!({
                    "id": id,
                    "customer_name": row["name"],
                    "service_name": row.get("service").cloned().unwrap_or(Value::Null),
                    "starts_at": py_isoformat(&start),
                    "ends_at": py_isoformat(&(start + ChronoDuration::hours(1))),
                    "status": row.get("status").cloned().unwrap_or(json!("confirmed")),
                    "arrived_at": if arrived.contains(&id) { json!("2026-01-01T00:00:00+09:00") } else { row.get("arrived_at").cloned().unwrap_or(Value::Null) },
                })
            })
            .collect()
    }
}

/// `capture.py`'s `tts_pcm`.
fn tts_pcm(text: &str, rate: u32) -> Vec<u8> {
    let mut out = Vec::new();
    for (index, ch) in text.chars().enumerate() {
        let samples = rate as usize * 40 / 1000;
        let amplitude = if "。！？".contains(ch) { 0.0 } else { 3000.0 + 50.0 * (index % 7) as f64 };
        for i in 0..samples {
            let value = (amplitude * (2.0 * std::f64::consts::PI * 300.0 * i as f64 / rate as f64).sin()) as i16;
            out.extend_from_slice(&value.to_le_bytes());
        }
    }
    out
}

fn sse(events: Vec<String>) -> Response {
    let body = events.concat();
    ([("content-type", "text/event-stream")], body).into_response()
}

async fn transcriptions(State(rec): State<Shared>, headers: HeaderMap, mut form: Multipart) -> Response {
    let mut fields = Map::new();
    while let Some(field) = form.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        if let Some(filename) = field.file_name().map(str::to_string) {
            let content_type = field.content_type().map(str::to_string);
            let data = field.bytes().await.unwrap();
            fields.insert(name, json!({
                "filename": filename,
                "content_type": content_type,
                "bytes": data.len(),
                "sha256": hex::encode(Sha256::digest(&data)),
            }));
        } else {
            fields.insert(name, json!(field.text().await.unwrap()));
        }
    }
    rec.record("POST", "/v1/audio/transcriptions", Map::new(), &headers, Value::Object(fields));
    let text = rec.asr.lock().unwrap().next().expect("scripted ASR text");
    Json(json!({"text": text})).into_response()
}

async fn chat(State(rec): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    rec.record("POST", "/v1/chat/completions", Map::new(), &headers, body.clone());
    let step = rec.llm.lock().unwrap().next().expect("scripted LLM step");
    let chunk = |delta: Value, finish: Option<&str>| {
        let data = json!({
            "id": "chatcmpl-oracle", "object": "chat.completion.chunk", "created": 0,
            "model": body.get("model"),
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        format!("data: {data}\n\n")
    };
    let mut events = Vec::new();
    if let Some(calls) = step.get("tool_calls").and_then(Value::as_array) {
        for (index, call) in calls.iter().enumerate() {
            let arguments = monban_backend::services::py_json_dumps_ensure_ascii_false(&call["arguments"]);
            events.push(chunk(json!({"role": "assistant", "tool_calls": [{"index": index, "id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": ""}}]}), None));
            events.push(chunk(json!({"tool_calls": [{"index": index, "function": {"arguments": arguments}}]}), None));
        }
        events.push(chunk(json!({}), Some("tool_calls")));
    } else {
        let text: Vec<char> = step["text"].as_str().unwrap().chars().collect();
        for (i, piece) in text.chunks(5).enumerate() {
            let piece: String = piece.iter().collect();
            events.push(chunk(if i == 0 { json!({"role": "assistant", "content": piece}) } else { json!({"content": piece}) }, None));
        }
        events.push(chunk(json!({}), Some("stop")));
    }
    events.push("data: [DONE]\n\n".into());
    sse(events)
}

async fn speech(State(rec): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    rec.record("POST", "/v1/audio/speech", Map::new(), &headers, body.clone());
    let pcm = tts_pcm(body["input"].as_str().unwrap(), rec.rate);
    if rec.scenario.get("tts_format").and_then(Value::as_str) == Some("sse") {
        let mut events: Vec<String> = pcm
            .chunks(3200)
            .map(|piece| {
                let delta = base64::engine::general_purpose::STANDARD.encode(piece);
                format!("data: {}\n\n", json!({"type": "speech.audio.delta", "delta": delta}))
            })
            .collect();
        events.push("data: {\"type\": \"speech.audio.done\"}\n\n".into());
        return sse(events);
    }
    ([("content-type", "audio/pcm")], pcm).into_response()
}

fn normalized_query(query: HashMap<String, String>) -> Map<String, Value> {
    query
        .into_iter()
        .map(|(key, value)| {
            let value = if key == "from" || key == "to" { format!("<date>{}", &value[10..]) } else { value };
            (key, Value::String(value))
        })
        .collect()
}

async fn list_reservations(State(rec): State<Shared>, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    rec.record("GET", "/functions/v1/device/reservations", normalized_query(query), &headers, Value::Null);
    Json(json!({"reservations": rec.reservations()})).into_response()
}

async fn arrive(State(rec): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    rec.record("POST", &format!("/functions/v1/device/reservations/{id}/arrive"), Map::new(), &headers, Value::Null);
    let row = rec.reservations().into_iter().find(|row| row["id"] == id.as_str());
    rec.arrived.lock().unwrap().push(id);
    match row {
        Some(row) => Json(json!({"reservation": row})).into_response(),
        None => (axum::http::StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response(),
    }
}

// ---------------------------------------------------------------------------------------
// Recording device sink
// ---------------------------------------------------------------------------------------

#[derive(Default)]
struct Sink {
    events: Mutex<Vec<Value>>,
    pcm: Mutex<Vec<u8>>,
    runtime: OnceLock<Weak<dyn VoiceRuntime>>,
}

#[async_trait::async_trait]
impl OutputSink for Sink {
    async fn write_audio(&self, pcm: Vec<u8>) -> anyhow::Result<()> {
        assert!(!pcm.is_empty() && pcm.len() <= 640 && pcm.len().is_multiple_of(2), "device frame size");
        let mut events = self.events.lock().unwrap();
        match events.last_mut() {
            Some(last) if last["type"] == "audio" => {
                last["frames"] = json!(last["frames"].as_u64().unwrap() + 1);
                last["bytes"] = json!(last["bytes"].as_u64().unwrap() + pcm.len() as u64);
            }
            _ => events.push(json!({"type": "audio", "frames": 1, "bytes": pcm.len()})),
        }
        self.pcm.lock().unwrap().extend_from_slice(&pcm);
        Ok(())
    }
    async fn finish_audio(&self) -> anyhow::Result<()> {
        let ends = self.runtime.get().and_then(Weak::upgrade).is_some_and(|r| r.end_after_reply());
        self.events.lock().unwrap().push(json!({"type": "finish", "end_after_reply": ends}));
        Ok(())
    }
    async fn wait_played(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn transcript(&self, speaker: &str, text: &str) -> anyhow::Result<()> {
        self.events.lock().unwrap().push(json!({"type": "transcript", "speaker": speaker, "text": text}));
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------

struct Outcome {
    requests: Vec<Value>,
    turns: Vec<Value>,
}

async fn replay(fixture: &Value) -> Outcome {
    let scenario = fixture["scenario"].clone();
    let rate = fixture["settings"]["tts_sample_rate"].as_u64().unwrap() as u32;
    let recorder = Arc::new(Recorder {
        rate,
        requests: Mutex::new(Vec::new()),
        asr: Mutex::new(list(&scenario, "asr").into_iter()),
        llm: Mutex::new(list(&scenario, "llm").into_iter()),
        arrived: Mutex::new(Vec::new()),
        scenario: scenario.clone(),
    });
    let app = Router::new()
        .route("/v1/audio/transcriptions", post(transcriptions))
        .route("/v1/chat/completions", post(chat))
        .route("/v1/audio/speech", post(speech))
        .route("/functions/v1/device/reservations", get(list_reservations))
        .route("/functions/v1/device/reservations/{id}/arrive", post(arrive))
        .with_state(recorder.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let env: HashMap<&str, String> = HashMap::from([
        ("DOOR_API_KEY", "k".repeat(40)),
        ("DOOR_ASR_BASE_URL", base.clone()),
        ("DOOR_TTS_BASE_URL", base.clone()),
        ("DOOR_OLLAMA_BASE_URL", base.clone()),
        ("DOOR_SUPABASE_URL", base.clone()),
        ("DOOR_SUPABASE_ANON_KEY", "sb_publishable_oracle".into()),
        ("DOOR_LLM_API_KEY", "llm-key".into()),
        ("DOOR_ASR_API_KEY", "asr-key".into()),
        ("DOOR_TTS_API_KEY", "tts-key".into()),
        ("DOOR_LLM_MODEL", fixture["settings"]["llm_model"].as_str().unwrap().into()),
        ("DOOR_TTS_SAMPLE_RATE", rate.to_string()),
        ("DOOR_WARMUP", "0".into()),
    ]);
    let settings = Arc::new(Settings::from_lookup(&|name| env.get(name).cloned()).unwrap());
    let models = Arc::new(live_models(settings, reqwest::Client::new()));
    let shop = scenario.get("shop").and_then(ShopProfile::from_json);
    let config = RuntimeConfig {
        house_rules: fixture["house_rules"].as_str().unwrap().into(),
        device_key: shop.as_ref().map(|_| "device-oracle".to_string()),
        shop,
    };
    let sink = Arc::new(Sink::default());
    let runtime: Arc<dyn VoiceRuntime> = Arc::new(DeviceRuntime::new(models, config, sink.clone()));
    let _ = sink.runtime.set(Arc::downgrade(&runtime));

    runtime.start().await.unwrap();
    let mut utterances: Vec<Option<Vec<u8>>> = vec![None];
    for frames in list(&scenario, "utterance_frames") {
        utterances.push(Some([1u8, 0].repeat(320 * frames.as_u64().unwrap() as usize)));
    }
    let mut turns = Vec::new();
    for (index, utterance) in utterances.into_iter().enumerate() {
        sink.events.lock().unwrap().clear();
        sink.pcm.lock().unwrap().clear();
        let text = match utterance {
            None => None,
            Some(pcm) => Some(runtime.recognize(pcm).await.unwrap()),
        };
        if text.as_deref().is_none_or(|text| !text.is_empty()) {
            runtime.reply(text.clone()).await.unwrap();
        }
        let pcm = sink.pcm.lock().unwrap().clone();
        turns.push(json!({
            "turn": index,
            "recognized": text,
            "events": sink.events.lock().unwrap().clone(),
            "pcm_samples": pcm.len() / 2,
            "pcm_sha256": hex::encode(Sha256::digest(&pcm)),
            "end_after_reply": runtime.end_after_reply(),
            "staff_requested": runtime.staff_requested(),
        }));
    }
    runtime.close().await;
    server.abort();
    let requests = recorder.requests.lock().unwrap().clone();
    let requests = serde_json::from_str::<Value>(
        &regex_replace_prefetch(&serde_json::to_string(&requests).unwrap()),
    )
    .unwrap();
    Outcome { requests: requests.as_array().unwrap().clone(), turns }
}

fn regex_replace_prefetch(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("monban-prefetch-") {
        out.push_str(&rest[..index]);
        out.push_str("monban-prefetch-<id>");
        rest = &rest[index + "monban-prefetch-".len()..];
        let hex_len = rest.chars().take_while(char::is_ascii_hexdigit).count();
        rest = &rest[hex_len..];
    }
    out.push_str(rest);
    out
}

/// Fields compared per turn. `end_after_reply` at finish is left out on purpose: the Rust
/// port decides it from the reply being sent (Issue #79), Python read the previous reply.
fn turn_view(turn: &Value) -> Value {
    let events: Vec<Value> = turn["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| {
            let mut event = event.clone();
            if let Some(map) = event.as_object_mut() {
                map.remove("end_after_reply");
            }
            event
        })
        .collect();
    json!({
        "recognized": turn["recognized"],
        "events": events,
        "pcm_samples": turn["pcm_samples"],
        "pcm_sha256": turn["pcm_sha256"],
        "end_after_reply": turn["end_after_reply"],
        "staff_requested": turn["staff_requested"],
    })
}

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/voice/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Requests in order per upstream. The reservation prefetch runs in the background beside
/// the greeting in both implementations, so only the order towards one upstream is fixed.
fn by_upstream(requests: &[Value]) -> Vec<Value> {
    let mut sorted = requests.to_vec();
    sorted.sort_by_key(|request| {
        let path = request["path"].as_str().unwrap_or("");
        if path.starts_with("/functions/") { 1 } else { 0 }
    });
    sorted
}

async fn check(name: &str) {
    let expected = fixture(name);
    let actual = replay(&expected).await;
    let expected_requests = by_upstream(expected["requests"].as_array().unwrap());
    let actual_requests = by_upstream(&actual.requests);
    for (index, (want, got)) in expected_requests.iter().zip(&actual_requests).enumerate() {
        assert_eq!(got, want, "{name}: request {index} differs");
    }
    assert_eq!(actual_requests.len(), expected_requests.len(), "{name}: request count");
    for (want, got) in expected["turns"].as_array().unwrap().iter().zip(&actual.turns) {
        assert_eq!(turn_view(got), turn_view(want), "{name}: turn {} differs", want["turn"]);
    }
    assert_eq!(actual.turns.len(), expected["turns"].as_array().unwrap().len());
}

#[tokio::test]
async fn door_delivery() {
    check("door_delivery").await;
}

#[tokio::test]
async fn door_llm_reply_sse() {
    check("door_llm_reply_sse").await;
}

#[tokio::test]
async fn door_llm_inspection() {
    check("door_llm_inspection").await;
}

#[tokio::test]
async fn door_llm_question_sse() {
    check("door_llm_question_sse").await;
}

#[tokio::test]
async fn door_closing_delivery() {
    check("door_closing_delivery").await;
}

#[tokio::test]
async fn door_wait_hook() {
    check("door_wait_hook").await;
}

#[tokio::test]
async fn shop_checkin_with_hook() {
    check("shop_checkin_with_hook").await;
}

#[tokio::test]
async fn shop_staff_hook() {
    check("shop_staff_hook").await;
}
