//! The model clients against a recording stand-in server, compared with the requests and
//! audio the Python v2 pipeline produced (`tests/fixtures/voice/*.json`, recorded by
//! `tools/voice_oracle/capture.py`), plus retry, timeout and warm-up behavior.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use base64::Engine;
use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};
use http_body_util::BodyExt;
use monban_backend::config::Settings;
use monban_backend::services::py_json_dumps_ensure_ascii_false;
use monban_backend::persistence::device_api::ShopProfile;
use monban_backend::reception::desk::ReceptionDesk;
use monban_backend::relay::OutputSink;
use monban_backend::voice::agents::{Agent, DoorAgent, ReceptionAgent};
use monban_backend::voice::session::Session;
use monban_backend::voice::clients::error::Service;
use monban_backend::voice::clients::llm::{LlmClient, LlmEvent};
use monban_backend::voice::clients::stt::{SttClient, ASR_PROMPT};
use monban_backend::voice::clients::text::{split_sentences, tts_text};
use monban_backend::voice::clients::tts::{livekit_marker_bytes, SpeechCppTts};
use monban_backend::voice::clients::{warmup, ClientError};
use monban_policy::agent_rules::{DOOR_GREETING, RECEPTION_GREETING};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------------------
// Recording stand-in server
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Recorded {
    method: String,
    path: String,
    authorization: Option<String>,
    content_type: String,
    body: Value,
}

impl Recorded {
    /// The fields `capture.py` records, except `query` and `apikey` (always empty here).
    fn as_fixture(&self) -> Value {
        json!({
            "method": self.method,
            "path": self.path,
            "authorization": self.authorization,
            "content_type": self.content_type,
            "body": self.body,
        })
    }
}

fn fixture_view(request: &Value) -> Value {
    json!({
        "method": request["method"],
        "path": request["path"],
        "authorization": request["authorization"],
        "content_type": request["content_type"],
        "body": request["body"],
    })
}

type Handler = Arc<dyn Fn(usize, Recorded) -> BoxFuture<'static, Response> + Send + Sync>;

struct Fake {
    base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl Fake {
    fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    fn count(&self, path: &str) -> usize {
        self.requests().iter().filter(|r| r.path == path).count()
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Parse multipart form data the way `capture.py` records it.
fn parse_multipart(content_type: &str, body: &[u8]) -> Value {
    let boundary = content_type.split("boundary=").nth(1).expect("boundary").trim_matches('"');
    let delimiter = format!("--{boundary}").into_bytes();
    let mut fields = Map::new();
    let mut parts = Vec::new();
    let mut rest = body;
    while let Some(index) = find(rest, &delimiter) {
        parts.push(&rest[..index]);
        rest = &rest[index + delimiter.len()..];
    }
    for part in parts.into_iter().skip(1) {
        let part = part.strip_prefix(b"\r\n").unwrap_or(part);
        let split = find(part, b"\r\n\r\n").expect("part headers");
        let headers = String::from_utf8_lossy(&part[..split]).to_string();
        let mut content = &part[split + 4..];
        content = content.strip_suffix(b"\r\n").unwrap_or(content);
        let disposition = headers
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-disposition:"))
            .expect("content disposition")
            .to_string();
        let attribute = |name: &str| {
            disposition
                .split(';')
                .map(str::trim)
                .find_map(|item| item.strip_prefix(&format!("{name}=\"")))
                .map(|value| value.trim_end_matches('"').to_string())
        };
        let name = attribute("name").expect("field name");
        let part_type = headers
            .lines()
            .find_map(|line| line.strip_prefix("Content-Type: ").or_else(|| line.strip_prefix("content-type: ")))
            .map(str::to_string);
        let value = match attribute("filename") {
            Some(filename) => json!({
                "filename": filename,
                "content_type": part_type,
                "bytes": content.len(),
                "sha256": sha256(content),
            }),
            None => Value::String(String::from_utf8(content.to_vec()).unwrap()),
        };
        fields.insert(name, value);
    }
    Value::Object(fields)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

async fn fake(handler: Handler) -> Fake {
    let requests: Arc<Mutex<Vec<Recorded>>> = Arc::default();
    let log = requests.clone();
    let app = axum::Router::new().fallback(move |request: Request| {
        let handler = handler.clone();
        let log = log.clone();
        async move {
            let (parts, body) = request.into_parts();
            let full_type = parts
                .headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let media_type = full_type.split(';').next().unwrap().trim().to_string();
            let bytes = body.collect().await.unwrap().to_bytes();
            let body = match media_type.as_str() {
                "application/json" => serde_json::from_slice(&bytes).unwrap(),
                "multipart/form-data" => parse_multipart(&full_type, &bytes),
                _ => Value::Null,
            };
            let recorded = Recorded {
                method: parts.method.to_string(),
                path: parts.uri.path().to_string(),
                authorization: parts.headers.get("authorization").map(|v| v.to_str().unwrap().to_string()),
                content_type: media_type,
                body,
            };
            let index = {
                let mut log = log.lock().unwrap();
                log.push(recorded.clone());
                log.len() - 1
            };
            handler(index, recorded).await
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fake { base, requests }
}

fn handler<F>(f: F) -> Handler
where
    F: Fn(usize, Recorded) -> Response + Send + Sync + 'static,
{
    Arc::new(move |index, recorded| {
        let response = f(index, recorded);
        async move { response }.boxed()
    })
}

fn response(status: u16, content_type: &str, body: impl Into<Body>) -> Response {
    let mut response = Response::new(body.into());
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response.headers_mut().insert("content-type", HeaderValue::from_str(content_type).unwrap());
    response
}

/// A body delivered as separate chunks.
fn chunked(content_type: &str, chunks: Vec<Vec<u8>>) -> Response {
    let stream = futures::stream::iter(chunks.into_iter().map(|chunk| Ok::<_, Infallible>(bytes::Bytes::from(chunk))));
    response(200, content_type, Body::from_stream(stream))
}

fn settings_for(base: &str, extra: &[(&str, &str)]) -> Arc<Settings> {
    let mut values: Vec<(String, String)> = vec![
        ("DOOR_API_KEY".into(), "k".repeat(40)),
        ("DOOR_ASR_BASE_URL".into(), base.into()),
        ("DOOR_TTS_BASE_URL".into(), base.into()),
        ("DOOR_OLLAMA_BASE_URL".into(), base.into()),
        ("DOOR_LLM_API_KEY".into(), "llm-key".into()),
        ("DOOR_ASR_API_KEY".into(), "asr-key".into()),
        ("DOOR_TTS_API_KEY".into(), "tts-key".into()),
        ("DOOR_LLM_MODEL".into(), "monban-oracle-llm".into()),
        ("DOOR_TTS_SAMPLE_RATE".into(), "16000".into()),
        ("DOOR_WARMUP".into(), "0".into()),
    ];
    values.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let settings = Settings::from_lookup(&move |name| {
        values.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    })
    .expect("test settings");
    Arc::new(settings)
}

fn fixtures() -> Vec<(String, Value)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/voice");
    let mut out: Vec<(String, Value)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            (name, serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap())
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(out.len() >= 8);
    out
}

fn fixture_requests<'a>(fixture: &'a Value, path: &str) -> Vec<&'a Value> {
    fixture["requests"].as_array().unwrap().iter().filter(|r| r["path"] == path).collect()
}

// ---------------------------------------------------------------------------------------
// The capture.py stand-ins
// ---------------------------------------------------------------------------------------

/// `capture.py` `tts_pcm`.
fn tts_pcm(text: &str, rate: u32) -> Vec<u8> {
    let mut out = Vec::new();
    for (index, c) in text.chars().enumerate() {
        let samples = rate * 40 / 1000;
        let amplitude = if "。！？".contains(c) { 0.0 } else { 3000.0 + 50.0 * (index % 7) as f64 };
        for i in 0..samples {
            let value = amplitude * (2.0 * std::f64::consts::PI * 300.0 * f64::from(i) / f64::from(rate)).sin();
            out.extend_from_slice(&(value as i16).to_le_bytes());
        }
    }
    out
}

/// `capture.py` `Recorder.speech`.
fn speech_response(body: &Value, rate: u32, sse: bool) -> Response {
    let pcm = tts_pcm(body["input"].as_str().unwrap(), rate);
    if !sse {
        return response(200, "audio/pcm", pcm);
    }
    let mut chunks: Vec<Vec<u8>> = pcm
        .chunks(3200)
        .map(|part| {
            let event = json!({"type": "speech.audio.delta", "delta": base64::engine::general_purpose::STANDARD.encode(part)});
            format!("data: {event}\n\n").into_bytes()
        })
        .collect();
    chunks.push(b"data: {\"type\": \"speech.audio.done\"}\n\n".to_vec());
    chunked("text/event-stream", chunks)
}

/// `capture.py` `Recorder.chat` for one scripted step.
fn chat_response(model: &str, step: &Value) -> Response {
    let chunk = |delta: Value, finish: Option<&str>| {
        let data = json!({
            "id": "chatcmpl-oracle",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        format!("data: {}\n\n", py_json_dumps_ensure_ascii_false(&data)).into_bytes()
    };
    let mut chunks = Vec::new();
    if let Some(calls) = step.get("tool_calls").and_then(Value::as_array) {
        for (index, call) in calls.iter().enumerate() {
            let args = py_json_dumps_ensure_ascii_false(&call["arguments"]);
            chunks.push(chunk(
                json!({"role": "assistant", "tool_calls": [{"index": index, "id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": ""}}]}),
                None,
            ));
            chunks.push(chunk(json!({"tool_calls": [{"index": index, "function": {"arguments": args}}]}), None));
        }
        chunks.push(chunk(json!({}), Some("tool_calls")));
    } else {
        let text: Vec<char> = step["text"].as_str().unwrap().chars().collect();
        for (i, piece) in text.chunks(5).enumerate() {
            let piece: String = piece.iter().collect();
            let delta = if i == 0 { json!({"role": "assistant", "content": piece}) } else { json!({"content": piece}) };
            chunks.push(chunk(delta, None));
        }
        chunks.push(chunk(json!({}), Some("stop")));
    }
    chunks.push(b"data: [DONE]\n\n".to_vec());
    chunked("text/event-stream", chunks)
}

async fn collect(stream: monban_backend::voice::clients::llm::LlmEventStream) -> (Vec<LlmEvent>, Option<anyhow::Error>) {
    let mut events = Vec::new();
    let mut stream = stream;
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => events.push(event),
            Err(error) => return (events, Some(error)),
        }
    }
    (events, None)
}

fn client_error(error: &anyhow::Error) -> &ClientError {
    error.downcast_ref::<ClientError>().expect("a ClientError")
}

// ---------------------------------------------------------------------------------------
// Fixture comparisons
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn stt_requests_match_fixtures() {
    let mut checked = 0;
    for (name, fixture) in fixtures() {
        let texts: Vec<String> =
            fixture["scenario"]["asr"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
        let replies = texts.clone();
        let server = fake(handler(move |index, _| {
            response(200, "application/json", json!({"text": replies[index]}).to_string())
        }))
        .await;
        let client = SttClient::new(settings_for(&server.base, &[]));
        let frames = fixture["scenario"]["utterance_frames"].as_array().unwrap();
        let expected = fixture_requests(&fixture, "/v1/audio/transcriptions");
        assert_eq!(frames.len(), expected.len(), "{name}");
        for (index, frames) in frames.iter().enumerate() {
            let pcm = [1u8, 0].repeat(320 * frames.as_u64().unwrap() as usize);
            let text = client.transcribe(&pcm).await.unwrap();
            assert_eq!(text, texts[index]);
        }
        let recorded = server.requests();
        assert_eq!(recorded.len(), expected.len());
        for (got, want) in recorded.iter().zip(expected) {
            assert_eq!(got.as_fixture(), fixture_view(want), "{name}");
            checked += 1;
        }
    }
    assert!(checked >= 10);
}

#[tokio::test]
async fn stt_sends_the_prompt_to_qwen_models() {
    let server = fake(handler(|_, _| response(200, "application/json", r#"{"text": " はい "}"#))).await;
    let client = SttClient::new(settings_for(&server.base, &[("DOOR_ASR_API_MODEL", "Qwen3-ASR-1.7B")]));
    assert_eq!(client.transcribe(&[0, 0]).await.unwrap(), " はい ");
    let body = &server.requests()[0].body;
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["model", "language", "prompt", "response_format", "file"]);
    assert_eq!(body["prompt"], ASR_PROMPT);
    assert_eq!(body["model"], "Qwen3-ASR-1.7B");
}

#[tokio::test]
async fn llm_requests_and_events_match_fixtures() {
    let mut checked = 0;
    for (name, fixture) in fixtures() {
        let expected = fixture_requests(&fixture, "/v1/chat/completions");
        if expected.is_empty() {
            continue;
        }
        let model = fixture["settings"]["llm_model"].as_str().unwrap().to_string();
        let steps = fixture["scenario"]["llm"].as_array().unwrap().clone();
        let script = steps.clone();
        let server_model = model.clone();
        let server = fake(handler(move |index, _| chat_response(&server_model, &script[index]))).await;
        let settings = settings_for(
            &server.base,
            &[
                ("DOOR_LLM_MODEL", &model),
                ("DOOR_LLM_MAX_TOKENS", &fixture["settings"]["llm_max_tokens"].to_string()),
                ("DOOR_LLM_KEEP_ALIVE", fixture["settings"]["llm_keep_alive"].as_str().unwrap()),
            ],
        );
        let client = LlmClient::new(settings);
        for (index, request) in expected.iter().enumerate() {
            let body = &request["body"];
            let messages = body["messages"].as_array().unwrap().clone();
            let tools = body.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
            let tool_choice = body.get("tool_choice").and_then(Value::as_str);
            let (events, error) = collect(client.stream(messages, tools, tool_choice).await.unwrap()).await;
            assert!(error.is_none(), "{name}: {error:?}");
            let step = &steps[index];
            if let Some(calls) = step.get("tool_calls").and_then(Value::as_array) {
                let want: Vec<LlmEvent> = calls
                    .iter()
                    .map(|call| LlmEvent::ToolCall {
                        call_id: call["id"].as_str().unwrap().into(),
                        name: call["name"].as_str().unwrap().into(),
                        arguments: py_json_dumps_ensure_ascii_false(&call["arguments"]),
                    })
                    .collect();
                assert_eq!(events, want, "{name}");
            } else {
                let text: String = events
                    .iter()
                    .map(|event| match event {
                        LlmEvent::Text(text) => text.clone(),
                        other => panic!("unexpected {other:?}"),
                    })
                    .collect();
                assert_eq!(text, step["text"].as_str().unwrap(), "{name}");
            }
        }
        let recorded = server.requests();
        assert_eq!(recorded.len(), expected.len(), "{name}");
        for (got, want) in recorded.iter().zip(&expected) {
            assert_eq!(got.as_fixture(), fixture_view(want), "{name}");
            checked += 1;
        }
    }
    // Includes shop_checkin_as_is' second call with "tool_choice": "auto".
    assert!(checked >= 7);
}

#[tokio::test]
async fn llm_body_omits_empty_tools_and_absent_tool_choice() {
    let settings = settings_for("http://127.0.0.1:1", &[]);
    let client = LlmClient::new(settings);
    let body = client.request_body(vec![json!({"role": "user", "content": "x"})], vec![], None);
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["model", "messages", "stream", "stream_options", "temperature", "reasoning_effort", "max_tokens", "keep_alive"]
    );
    let body = client.request_body(vec![], vec![json!({"type": "function"})], Some("none"));
    assert_eq!(body["tool_choice"], "none");
    assert_eq!(body["tools"], json!([{"type": "function"}]));
    assert!(body.get("parallel_tool_calls").is_none());
}

/// livekit's blingfire `SentenceTokenizer` (`min_sentence_len=20`) for Japanese replies:
/// sentences shorter than 20 code points are merged into the next one. The sentence
/// boundaries here are `_split_sentences`', which agree with blingfire on these texts.
fn adapter_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for sentence in split_sentences(text) {
        current.push_str(&sentence);
        if current.chars().count() >= 20 {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[tokio::test]
async fn tts_requests_and_audio_match_fixtures() {
    let mut turns_checked = 0;
    for (name, fixture) in fixtures() {
        let sse = fixture["scenario"]["tts_format"] == "sse";
        let rate = fixture["settings"]["tts_sample_rate"].as_u64().unwrap() as u32;
        assert_eq!(rate, 16000);
        let server = fake(handler(move |_, recorded| speech_response(&recorded.body, rate, sse))).await;
        let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
        for turn in fixture["turns"].as_array().unwrap() {
            let replies: Vec<&str> = turn["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["type"] == "transcript" && event["speaker"] == "ai")
                .map(|event| event["text"].as_str().unwrap())
                .collect();
            assert!(replies.len() <= 1);
            let Some(reply) = replies.first() else {
                assert_eq!(turn["pcm_samples"], 0, "{name}");
                continue;
            };
            // As livekit's StreamAdapter: one synthesize call and one 10 ms marker per
            // token, one more marker at the end of the reply.
            let mut pcm = Vec::new();
            for token in adapter_tokens(&tts_text([*reply])) {
                pcm.extend(tts.synthesize(&token).await.unwrap());
                pcm.extend(std::iter::repeat_n(0u8, livekit_marker_bytes(rate)));
            }
            pcm.extend(std::iter::repeat_n(0u8, livekit_marker_bytes(rate)));
            assert_eq!(pcm.len() as u64 / 2, turn["pcm_samples"].as_u64().unwrap(), "{name} turn {}", turn["turn"]);
            assert_eq!(sha256(&pcm), turn["pcm_sha256"].as_str().unwrap(), "{name} turn {}", turn["turn"]);
            if let Some(encoded) = turn["pcm_base64"].as_str() {
                assert_eq!(pcm, base64::engine::general_purpose::STANDARD.decode(encoded).unwrap());
            }
            turns_checked += 1;
        }
        let expected = fixture_requests(&fixture, "/v1/audio/speech");
        let recorded = server.requests();
        assert_eq!(recorded.len(), expected.len(), "{name}");
        for (got, want) in recorded.iter().zip(&expected) {
            assert_eq!(got.as_fixture(), fixture_view(want), "{name}");
        }
    }
    assert!(turns_checked >= 15);
}

// ---------------------------------------------------------------------------------------
// TTS behavior
// ---------------------------------------------------------------------------------------

async fn wait_for_requests(server: &Fake, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while server.requests().len() < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("expected fake TTS request");
}

#[tokio::test]
async fn fixed_greetings_are_single_flight_across_clones() {
    let server = fake(Arc::new(|_, recorded| async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        speech_response(&recorded.body, 16000, false)
    }.boxed())).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    let clone = tts.clone();
    let (first, second) = tokio::join!(tts.synthesize(DOOR_GREETING), clone.synthesize(DOOR_GREETING));
    let first = first.unwrap();
    assert_eq!(first, second.unwrap());
    assert_eq!(first, tts_pcm(DOOR_GREETING, 16000));
    assert_eq!(tts.synthesize(DOOR_GREETING).await.unwrap(), first);
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn live_models_prewarm_both_fixed_greetings_without_blocking_startup() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let handler_gate = gate.clone();
    let server = fake(Arc::new(move |index, recorded| {
        let gate = handler_gate.clone();
        async move {
            if index == 0 { gate.notified().await; }
            speech_response(&recorded.body, 16000, false)
        }.boxed()
    })).await;
    // Constructing the real shared models returns while the first synthesis is blocked.
    let models = monban_backend::voice::adapters::live_models(
        settings_for(&server.base, &[("DOOR_WARMUP", "1")]), reqwest::Client::new(),
    );
    wait_for_requests(&server, 1).await;
    let speech = models.speech.clone();
    let call = tokio::spawn(async move { speech.synthesize(DOOR_GREETING).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!call.is_finished());
    assert_eq!(server.requests().len(), 1); // The call joins prewarm, not another request.
    gate.notify_one();
    assert_eq!(call.await.unwrap().unwrap(), tts_pcm(DOOR_GREETING, 16000));
    wait_for_requests(&server, 3).await; // Door + the two reception sentences.
    let reception = models.speech.synthesize(RECEPTION_GREETING).await.unwrap();
    let expected: Vec<u8> = split_sentences(RECEPTION_GREETING)
        .iter().flat_map(|sentence| tts_pcm(sentence, 16000)).collect();
    assert_eq!(reception, expected);
    models.speech.synthesize(DOOR_GREETING).await.unwrap();
    models.speech.synthesize(RECEPTION_GREETING).await.unwrap();
    assert_eq!(server.requests().len(), 3);
}

#[derive(Default)]
struct GreetingSink {
    pcm: Mutex<Vec<u8>>,
    transcripts: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl OutputSink for GreetingSink {
    async fn write_audio(&self, pcm: Vec<u8>) -> anyhow::Result<()> {
        assert!(!pcm.is_empty() && pcm.len() <= 640 && pcm.len().is_multiple_of(2));
        self.pcm.lock().unwrap().extend(pcm);
        Ok(())
    }
    async fn finish_audio(&self) -> anyhow::Result<()> { Ok(()) }
    async fn wait_played(&self) -> anyhow::Result<()> { Ok(()) }
    async fn transcript(&self, speaker: &str, text: &str) -> anyhow::Result<()> {
        assert_eq!(speaker, "ai");
        self.transcripts.lock().unwrap().push(text.to_string());
        Ok(())
    }
}

#[tokio::test]
async fn session_speaker_hits_prewarmed_greetings_after_filtering_and_tokenization() {
    let server = fake(handler(|_, recorded| speech_response(&recorded.body, 16000, false))).await;
    let settings = settings_for(&server.base, &[("DOOR_WARMUP", "1")]);
    let models = monban_backend::voice::adapters::live_models(settings.clone(), reqwest::Client::new());
    wait_for_requests(&server, 3).await;
    models.speech.synthesize(RECEPTION_GREETING).await.unwrap(); // prewarm is complete
    let spaced_reception = format!("{RECEPTION_GREETING} ");
    let custom = "いらっしゃいませ。MONBAN店へようこそ。";
    for (shop_greeting, text, extra_requests) in [
        (None, DOOR_GREETING, 0),
        (Some(""), RECEPTION_GREETING, 0),
        (Some(spaced_reception.as_str()), spaced_reception.as_str(), 0),
        (Some(custom), custom, 4),
    ] {
        let before = server.requests().len();
        for _ in 0..2 {
            let agent: Box<dyn Agent> = match shop_greeting {
                None => Box::new(DoorAgent::new("", settings.max_house_rules_chars, &settings.house_rules)),
                Some(greeting) => Box::new(ReceptionAgent::new(
                    Arc::new(ReceptionDesk::new(None, Duration::from_secs(30))),
                    Some(ShopProfile { greeting: greeting.into(), ..Default::default() }),
                )),
            };
            let sink = GreetingSink::default();
            Session::new(agent).greet(models.speech.as_ref(), &sink).await.unwrap();
            // Both fixed greetings are one StreamAdapter token; sentence splitting,
            // trimming, the two marker frames and device framing preserve the old PCM.
            let mut expected: Vec<u8> = split_sentences(text)
                .iter().flat_map(|sentence| tts_pcm(sentence, 16000)).collect();
            expected.extend(vec![0; 2 * livekit_marker_bytes(16000)]);
            assert_eq!(*sink.pcm.lock().unwrap(), expected, "{text}");
            assert_eq!(*sink.transcripts.lock().unwrap(), [text], "{text}");
        }
        assert_eq!(server.requests().len() - before, extra_requests, "{text}");
    }
}

#[tokio::test]
async fn greeting_prewarm_is_scheduled_once_and_failures_retry_on_demand() {
    let server = fake(handler(|index, recorded| {
        if index == 0 { response(400, "application/json", "{}") }
        else { speech_response(&recorded.body, 16000, false) }
    })).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[("DOOR_WARMUP", "1")]));
    tts.schedule_greeting_prewarm();
    tts.clone().schedule_greeting_prewarm();
    wait_for_requests(&server, 3).await;
    tts.synthesize(RECEPTION_GREETING).await.unwrap();
    assert_eq!(tts.synthesize(DOOR_GREETING).await.unwrap(), tts_pcm(DOOR_GREETING, 16000));
    tts.synthesize(DOOR_GREETING).await.unwrap();
    assert_eq!(server.requests().len(), 4); // Failed prewarm is not cached.
}

#[tokio::test]
async fn timed_out_greeting_prewarm_releases_the_entry_for_on_demand_retry() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let handler_gate = gate.clone();
    let server = fake(Arc::new(move |index, recorded| {
        let gate = handler_gate.clone();
        async move {
            if index == 0 { gate.notified().await; }
            speech_response(&recorded.body, 16000, false)
        }.boxed()
    })).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[
        ("DOOR_WARMUP", "1"), ("DOOR_WARMUP_TIMEOUT_SECONDS", "0.05"),
    ]));
    tts.schedule_greeting_prewarm();
    wait_for_requests(&server, 3).await;
    let pcm = tokio::time::timeout(Duration::from_secs(1), tts.synthesize(DOOR_GREETING))
        .await.expect("cancelled initialization must not hold the entry").unwrap();
    assert_eq!(pcm, tts_pcm(DOOR_GREETING, 16000));
    tts.synthesize(DOOR_GREETING).await.unwrap();
    assert_eq!(server.requests().len(), 4);
    gate.notify_one();
}

#[tokio::test]
async fn custom_greetings_and_non_exact_text_are_not_cached() {
    let server = fake(handler(|_, recorded| speech_response(&recorded.body, 16000, false))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    for text in ["いらっしゃいませ。MONBAN店へようこそ。", "はい、どちら様でしょうか。 "] {
        let before = server.requests().len();
        let first = tts.synthesize(text).await.unwrap();
        let requests = server.requests().len() - before;
        assert_eq!(tts.synthesize(text).await.unwrap(), first);
        assert_eq!(server.requests().len() - before, requests * 2);
    }
}

#[tokio::test]
async fn greeting_cache_never_crosses_tts_settings_or_upstream_clients() {
    let server = fake(handler(|index, _| response(200, "audio/pcm", ((index + 1) as u16).to_le_bytes().to_vec()))).await;
    let baseline = SpeechCppTts::new(settings_for(&server.base, &[]));
    assert_eq!(baseline.synthesize(DOOR_GREETING).await.unwrap(), [1, 0]);
    for (index, extra) in [
        ("DOOR_TTS_VOICE", "other-voice"), ("DOOR_TTS_SEED", "42"),
        ("DOOR_TTS_INSTRUCTIONS", "other instructions"), ("DOOR_TTS_SAMPLE_RATE", "48000"),
        ("DOOR_TTS_API_MODEL", "other-model"), ("DOOR_TTS_API_KEY", "other-test-key"),
    ].iter().enumerate() {
        let tts = SpeechCppTts::new(settings_for(&server.base, &[*extra]));
        let expected = ((index + 2) as u16).to_le_bytes().to_vec();
        assert_eq!(tts.synthesize(DOOR_GREETING).await.unwrap(), expected);
        assert_eq!(tts.synthesize(DOOR_GREETING).await.unwrap(), expected);
    }
    let other = fake(handler(|_, _| response(200, "audio/pcm", vec![99u8, 0]))).await;
    let tts = SpeechCppTts::new(settings_for(&other.base, &[]));
    assert_eq!(tts.synthesize(DOOR_GREETING).await.unwrap(), [99, 0]);
    assert_eq!(baseline.synthesize(DOOR_GREETING).await.unwrap(), [1, 0]);
    assert_eq!(server.requests().len(), 7);
    assert_eq!(other.requests().len(), 1);
}

#[tokio::test]
async fn disabled_prewarm_makes_no_requests_but_keeps_lazy_caching() {
    let server = fake(handler(|_, recorded| speech_response(&recorded.body, 16000, false))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    tts.schedule_greeting_prewarm();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(server.requests().is_empty());
    tts.synthesize(DOOR_GREETING).await.unwrap();
    tts.synthesize(DOOR_GREETING).await.unwrap();
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn tts_trims_a_delayed_tail_per_sentence() {
    // One sentence whose audio resumes after 1.5 s of silence: cut 180 ms into the gap.
    let mut tail = vec![0u8; 0];
    tail.extend(tts_pcm("ああ", 16000));
    tail.extend(vec![0u8; 24000 * 2]);
    tail.extend(tts_pcm("ん", 16000));
    let audio = tail.clone();
    let server = fake(handler(move |_, _| response(200, "application/octet-stream", audio.clone()))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    let pcm = tts.synthesize("はい。").await.unwrap();
    assert_eq!(pcm.len(), (1280 + 2880) * 2);
}

#[tokio::test]
async fn tts_rejects_bad_streams() {
    // SSE without a completion event.
    let server = fake(handler(|_, _| chunked("text/event-stream", vec![b"data: {\"type\": \"speech.audio.delta\", \"delta\": \"AQA=\"}\n\n".to_vec()]))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    let started = Instant::now();
    let error = tts.synthesize("はい。").await.unwrap_err();
    assert!(matches!(error, ClientError::Protocol { service: Service::Tts, .. }));
    // ChunkedStream retries retryable errors 3 times (0.1 s, 2 s, 2 s).
    assert_eq!(server.count("/v1/audio/speech"), 4);
    assert!(started.elapsed() >= Duration::from_millis(4000));

    // Odd raw PCM is not retried? It is an APIError, so it is.
    let server = fake(handler(|index, _| {
        if index == 0 {
            response(200, "audio/pcm", vec![1u8, 0, 2])
        } else {
            response(200, "audio/pcm", vec![1u8, 0])
        }
    }))
    .await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    assert_eq!(tts.synthesize("はい。").await.unwrap(), vec![1, 0]);
    assert_eq!(server.count("/v1/audio/speech"), 2);

    // Invalid JSON in the stream is a plain exception in Python: no retry.
    let server = fake(handler(|_, _| chunked("text/event-stream", vec![b"data: {oops\n\n".to_vec()]))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    assert!(!tts.synthesize("はい。").await.unwrap_err().retryable());
    assert_eq!(server.count("/v1/audio/speech"), 1);

    // A 4xx status is not retried; an unsupported content type is.
    let server = fake(handler(|_, _| response(400, "application/json", "{}"))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    assert_eq!(tts.synthesize("はい。").await.unwrap_err(), ClientError::Status { service: Service::Tts, status: 400 });
    assert_eq!(server.count("/v1/audio/speech"), 1);
}

#[tokio::test]
async fn tts_sse_last_line_without_newline_and_done_marker() {
    let server = fake(handler(|_, _| {
        chunked(
            "text/event-stream",
            vec![
                b": comment\ndata: {\"type\": \"speech.audio.delta\", \"audio\": \"AQACAA==\"}\n".to_vec(),
                b"data: {\"type\": \"other\"}\n".to_vec(),
                b"data: [DONE]".to_vec(),
            ],
        )
    }))
    .await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[]));
    assert_eq!(tts.synthesize("はい").await.unwrap(), vec![1, 0, 2, 0]);
    // Blank text: no request at all.
    assert!(tts.synthesize("  ").await.unwrap().is_empty());
    assert_eq!(server.count("/v1/audio/speech"), 1);
}

#[tokio::test]
async fn tts_sends_each_sentence_and_omits_empty_instructions() {
    let server = fake(handler(|_, recorded| speech_response(&recorded.body, 16000, false))).await;
    let tts = SpeechCppTts::new(settings_for(&server.base, &[("DOOR_TTS_INSTRUCTIONS", "")]));
    let pcm = tts.synthesize("一つ目。二つ目！三つ目").await.unwrap();
    let inputs: Vec<Value> = server.requests().iter().map(|r| r.body["input"].clone()).collect();
    assert_eq!(inputs, [json!("一つ目。"), json!("二つ目！"), json!("三つ目")]);
    assert!(server.requests().iter().all(|r| r.body.get("instructions").is_none()));
    assert_eq!(pcm.len(), (4 + 4 + 3) * 640 * 2);
}

// ---------------------------------------------------------------------------------------
// Retries and timeouts
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn stt_retries_once_on_server_errors_only() {
    let server = fake(handler(|_, _| response(503, "application/json", "{}"))).await;
    let client = SttClient::new(settings_for(&server.base, &[]));
    let error = client.transcribe(&[0, 0]).await.unwrap_err();
    assert_eq!(error, ClientError::Status { service: Service::Asr, status: 503 });
    assert_eq!(server.count("/v1/audio/transcriptions"), 2);

    let server = fake(handler(|_, _| response(401, "application/json", "{}"))).await;
    let client = SttClient::new(settings_for(&server.base, &[]));
    assert!(client.transcribe(&[0, 0]).await.is_err());
    assert_eq!(server.count("/v1/audio/transcriptions"), 1);

    let server = fake(handler(|index, _| {
        if index == 0 {
            response(200, "application/json", "not json")
        } else {
            response(200, "application/json", r#"{"text": "はい"}"#)
        }
    }))
    .await;
    let client = SttClient::new(settings_for(&server.base, &[]));
    assert_eq!(client.transcribe(&[0, 0]).await.unwrap(), "はい");
    assert_eq!(server.count("/v1/audio/transcriptions"), 2);
}

#[tokio::test]
async fn stt_connection_failure_is_retried() {
    // Nothing listens on this port.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = SttClient::new(settings_for(&base, &[]));
    let started = Instant::now();
    let error = client.transcribe(&[0, 0]).await.unwrap_err();
    assert!(matches!(error, ClientError::Connection { service: Service::Asr, .. }), "{error:?}");
    assert!(started.elapsed() >= Duration::from_millis(100));
}

#[tokio::test]
async fn llm_server_errors_are_retried_by_the_sdk_and_the_session() {
    let server = fake(handler(|_, _| response(503, "application/json", "{}"))).await;
    let client = LlmClient::new(settings_for(&server.base, &[]));
    let error = client.stream(vec![], vec![], None).await.err().expect("error");
    assert_eq!(client_error(&error), &ClientError::Status { service: Service::Llm, status: 503 });
    // openai max_retries=1 inside livekit max_retry=1.
    assert_eq!(server.count("/v1/chat/completions"), 4);

    let server = fake(handler(|_, _| response(400, "application/json", "{}"))).await;
    let client = LlmClient::new(settings_for(&server.base, &[]));
    let error = client.stream(vec![], vec![], None).await.err().expect("error");
    assert!(!client_error(&error).retryable());
    assert_eq!(server.count("/v1/chat/completions"), 1);

    let server = fake(handler(|index, _| {
        if index == 0 {
            let mut response = response(500, "application/json", "{}");
            response.headers_mut().insert("retry-after-ms", HeaderValue::from_static("10"));
            response
        } else {
            chat_response("m", &json!({"text": "はい。"}))
        }
    }))
    .await;
    let client = LlmClient::new(settings_for(&server.base, &[]));
    let (events, error) = collect(client.stream(vec![], vec![], None).await.unwrap()).await;
    assert!(error.is_none());
    assert_eq!(events, vec![LlmEvent::Text("はい。".into())]);
    assert_eq!(server.count("/v1/chat/completions"), 2);
}

#[tokio::test]
async fn llm_stream_errors_retry_only_before_the_first_event() {
    // An error event before any output: retried by the session.
    let server = fake(handler(|index, _| {
        if index == 0 {
            chunked("text/event-stream", vec![b"data: {\"error\": {\"message\": \"boom\"}}\n\n".to_vec()])
        } else {
            chat_response("m", &json!({"text": "どうぞ"}))
        }
    }))
    .await;
    let client = LlmClient::new(settings_for(&server.base, &[]));
    let (events, error) = collect(client.stream(vec![], vec![], None).await.unwrap()).await;
    assert!(error.is_none());
    assert_eq!(events, vec![LlmEvent::Text("どうぞ".into())]);
    assert_eq!(server.count("/v1/chat/completions"), 2);

    // An error after output ends the stream with that error, without a retry.
    let server = fake(handler(|_, _| {
        chunked(
            "text/event-stream",
            vec![
                b"data: {\"choices\": [{\"index\": 0, \"delta\": {\"content\": \"\xe3\x81\xaf\"}, \"finish_reason\": null}]}\n\n".to_vec(),
                b"data: not json\n\n".to_vec(),
            ],
        )
    }))
    .await;
    let client = LlmClient::new(settings_for(&server.base, &[]));
    let (events, error) = collect(client.stream(vec![], vec![], None).await.unwrap()).await;
    assert_eq!(events, vec![LlmEvent::Text("は".into())]);
    assert!(matches!(client_error(&error.unwrap()), ClientError::Protocol { .. }));
    assert_eq!(server.count("/v1/chat/completions"), 1);

    // A reply with no output at all is an empty stream, not an error.
    let server = fake(handler(|_, _| chunked("text/event-stream", vec![b"data: [DONE]\n\n".to_vec()]))).await;
    let client = LlmClient::new(settings_for(&server.base, &[]));
    let (events, error) = collect(client.stream(vec![], vec![], None).await.unwrap()).await;
    assert!(events.is_empty() && error.is_none());
}

#[tokio::test]
async fn llm_timeout_applies_to_waiting_for_the_response() {
    let slow: Handler = Arc::new(|_, _| {
        async {
            tokio::time::sleep(Duration::from_secs(2)).await;
            response(200, "text/event-stream", "data: [DONE]\n\n")
        }
        .boxed()
    });
    let server = fake(slow).await;
    let client = LlmClient::new(settings_for(&server.base, &[("DOOR_LLM_TIMEOUT_SECONDS", "0.2")]));
    let error = client.stream(vec![], vec![], None).await.err().expect("timeout");
    assert_eq!(client_error(&error), &ClientError::Timeout { service: Service::Llm });
    assert_eq!(server.count("/v1/chat/completions"), 4);
}

// ---------------------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn warm_up_probes_all_three_models() {
    let server = fake(handler(|_, recorded| match recorded.path.as_str() {
        "/v1/audio/speech" => response(200, "audio/pcm", vec![0u8; 64]),
        _ => response(200, "application/json", "{}"),
    }))
    .await;
    let settings = settings_for(&server.base, &[("DOOR_WARMUP", "1")]);
    assert!(warmup::warm_models(&settings).await);
    let mut requests = server.requests();
    requests.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(requests.len(), 3);
    let speech = &requests[0];
    assert_eq!(speech.path, "/v1/audio/speech");
    assert_eq!(speech.body["input"], "はい。");
    assert_eq!(speech.authorization.as_deref(), Some("Bearer tts-key"));
    let asr = &requests[1];
    assert_eq!(asr.path, "/v1/audio/transcriptions");
    assert_eq!(
        asr.body,
        json!({
            "file": {"filename": "warmup.wav", "content_type": "audio/wav", "bytes": 44 + 25600, "sha256": asr.body["file"]["sha256"]},
            "model": "kotoba-tech/kotoba-whisper-v2.1",
            "language": "ja",
            "response_format": "json",
        })
    );
    let llm = &requests[2];
    assert_eq!(llm.path, "/v1/chat/completions");
    assert_eq!(
        llm.body,
        json!({
            "model": "monban-oracle-llm",
            "messages": [{"role": "user", "content": "こんにちは"}],
            "stream": false,
            "max_tokens": 1,
            "temperature": 0,
        })
    );
    assert_eq!(llm.authorization.as_deref(), Some("Bearer llm-key"));
}

#[tokio::test]
async fn warm_up_reports_failure_without_raising() {
    let server = fake(handler(|_, recorded| match recorded.path.as_str() {
        "/v1/chat/completions" => response(500, "application/json", "{}"),
        _ => response(200, "application/json", "{}"),
    }))
    .await;
    let settings = settings_for(&server.base, &[("DOOR_WARMUP", "1")]);
    assert!(!warmup::warm_models(&settings).await);
    assert_eq!(server.requests().len(), 3);

    let disabled = settings_for(&server.base, &[("DOOR_WARMUP", "0")]);
    assert!(warmup::warm_models(&disabled).await);
    assert_eq!(server.requests().len(), 3);
}

#[tokio::test]
async fn warm_up_schedule_runs_once_after_success() {
    let server = fake(handler(|_, _| response(200, "application/json", "{}"))).await;
    let settings = settings_for(&server.base, &[("DOOR_WARMUP", "1")]);
    warmup::schedule(settings.clone());
    warmup::schedule(settings.clone()); // still running: ignored
    let deadline = Instant::now() + Duration::from_secs(5);
    while !warmup::warmed() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(warmup::warmed());
    warmup::schedule(settings); // succeeded already: ignored
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(server.requests().len(), 3);
    warmup::shutdown().await;
}
