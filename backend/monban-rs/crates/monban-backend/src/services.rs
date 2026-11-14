//! Upstream service checks, agent dispatch and the TTS preview (port of `core/services.py`
//! and the upstream calls in `api.py`).
//!
//! The API handlers reach upstreams only through [`Services`] so tests can replace them.

use std::time::Duration;

use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};

use crate::config::Settings;
use crate::livekit::LiveKitApi;
use crate::persistence::device_api::{DeviceApi, DeviceSettings};

/// An upstream failure the API reports as `{"detail": ...}` with this status.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{status}: {detail}")]
pub struct HttpError {
    pub status: u16,
    pub detail: String,
}

impl HttpError {
    pub fn new(status: u16, detail: impl Into<String>) -> Self {
        Self { status, detail: detail.into() }
    }
}

#[async_trait::async_trait]
pub trait Services: Send + Sync {
    async fn model_available(
        &self,
        base_url: &str,
        expected_model: &str,
        voice: Option<&str>,
        api_key: &str,
    ) -> bool;
    async fn llm_available(&self) -> bool;
    async fn livekit_available(&self) -> bool;
    /// Start the LiveKit agent. `reception` (device key and shop) selects shop reception.
    async fn dispatch_agent(
        &self,
        room: &str,
        house_rules: &str,
        reception: Option<Value>,
    ) -> anyhow::Result<()>;
    async fn fetch_device_settings(&self, device_key: &str) -> Option<DeviceSettings>;
    /// Mono 16-bit WAV of `text` from the TTS service.
    async fn synthesize_preview(&self, text: &str) -> Result<Vec<u8>, HttpError>;
}

/// The real upstreams.
pub struct LiveServices {
    settings: std::sync::Arc<Settings>,
    http: reqwest::Client,
    livekit: LiveKitApi,
    device_api: DeviceApi,
}

impl LiveServices {
    pub fn new(settings: std::sync::Arc<Settings>, http: reqwest::Client) -> Self {
        let livekit = LiveKitApi::new(http.clone(), &settings);
        let device_api = DeviceApi::new(http.clone(), &settings);
        Self { settings, http, livekit, device_api }
    }
}

#[async_trait::async_trait]
impl Services for LiveServices {
    async fn model_available(
        &self,
        base_url: &str,
        expected_model: &str,
        voice: Option<&str>,
        api_key: &str,
    ) -> bool {
        let mut request = self
            .http
            .get(format!("{}/v1/models", base_url.trim_end_matches('/')))
            .timeout(Duration::from_secs(2));
        if !api_key.is_empty() {
            request = request.bearer_auth(api_key);
        }
        let Ok(response) = request.send().await else { return false };
        if response.status().as_u16() != 200 {
            return false;
        }
        let Ok(data) = response.json::<Value>().await else { return false };
        let Some(models) = data.get("data").and_then(Value::as_array) else { return false };
        let Some(found) = models.iter().find(|model| model.get("id").and_then(Value::as_str) == Some(expected_model)) else {
            return false;
        };
        match voice.filter(|voice| !voice.is_empty()) {
            None => true,
            Some(voice) => found
                .get("speech")
                .and_then(|speech| speech.get("voices"))
                .and_then(Value::as_array)
                .is_some_and(|voices| {
                    voices.iter().any(|item| item.get("name").and_then(Value::as_str) == Some(voice))
                }),
        }
    }

    async fn llm_available(&self) -> bool {
        let response = self
            .http
            .get(format!("{}/v1/models", self.settings.ollama_base_url))
            .bearer_auth(&self.settings.llm_api_key)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        let Ok(response) = response else { return false };
        if response.status().as_u16() != 200 {
            return false;
        }
        let Ok(data) = response.json::<Value>().await else { return false };
        data.get("data").and_then(Value::as_array).is_some_and(|items| {
            items.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(&self.settings.llm_model))
        })
    }

    async fn livekit_available(&self) -> bool {
        match self.livekit.list_rooms().await {
            Ok(_) => true,
            Err(error) => {
                tracing::info!("livekit health check failed: {error}");
                false
            }
        }
    }

    async fn dispatch_agent(
        &self,
        room: &str,
        house_rules: &str,
        reception: Option<Value>,
    ) -> anyhow::Result<()> {
        let mut metadata = serde_json::Map::new();
        metadata.insert("house_rules".into(), house_rules.into());
        if let Some(reception) = reception {
            metadata.insert("reception".into(), reception);
        }
        self.livekit
            .create_dispatch(
                &self.settings.livekit_agent_name,
                room,
                &py_json_dumps_ensure_ascii_false(&Value::Object(metadata)),
            )
            .await
    }

    async fn fetch_device_settings(&self, device_key: &str) -> Option<DeviceSettings> {
        self.device_api.fetch_device_settings(device_key).await
    }

    async fn synthesize_preview(&self, text: &str) -> Result<Vec<u8>, HttpError> {
        let settings = &self.settings;
        let mut body = json!({
            "model": settings.tts_model,
            "input": text,
            "voice": settings.tts_voice,
            "language": "ja",
            "seed": settings.tts_seed,
            "response_format": "pcm",
            "stream_format": "sse",
        });
        if !settings.tts_instructions.is_empty() {
            body["instructions"] = settings.tts_instructions.clone().into();
        }
        let unavailable = || HttpError::new(503, "音声モデルに接続できません。");
        let response = self
            .http
            .post(format!("{}/v1/audio/speech", settings.tts_base_url))
            .bearer_auth(&settings.tts_api_key)
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|_| unavailable())?;
        if response.status().as_u16() != 200 {
            return Err(unavailable());
        }
        let content_type = content_type(&response);
        let mut pcm: Vec<u8> = Vec::new();
        let limit = settings.max_tts_response_bytes;
        let append = |pcm: &mut Vec<u8>, chunk: &[u8]| -> Result<(), HttpError> {
            if pcm.len() + chunk.len() > limit {
                return Err(HttpError::new(502, "音声モデルの応答が上限を超えました。"));
            }
            pcm.extend_from_slice(chunk);
            Ok(())
        };
        let mut stream = response.bytes_stream();
        match content_type.as_str() {
            "text/event-stream" => {
                let mut lines = LineSplitter::default();
                let mut ended = false;
                'outer: while !ended {
                    // The final line may arrive without a newline before the stream ends.
                    let batch = match stream.next().await {
                        Some(chunk) => lines.push(&chunk.map_err(|_| unavailable())?),
                        None => {
                            ended = true;
                            lines.finish().into_iter().collect()
                        }
                    };
                    for raw in batch {
                        match parse_sse_line(&raw) {
                            SseEvent::Done => break 'outer,
                            SseEvent::Audio(base64_audio) => {
                                let audio = base64::engine::general_purpose::STANDARD
                                    .decode(base64_audio.as_bytes())
                                    .map_err(|_| unavailable())?;
                                append(&mut pcm, &audio)?;
                            }
                            SseEvent::Error => {
                                return Err(HttpError::new(503, "音声の生成に失敗しました。"))
                            }
                            SseEvent::Finished | SseEvent::Other => {}
                        }
                    }
                }
            }
            "audio/pcm" | "application/octet-stream" => {
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| unavailable())?;
                    append(&mut pcm, &chunk)?;
                }
            }
            _ => return Err(HttpError::new(503, "音声モデルの応答形式に対応していません。")),
        }
        if pcm.is_empty() || !pcm.len().is_multiple_of(2) {
            return Err(HttpError::new(503, "音声モデルから有効な音声を取得できません。"));
        }
        Ok(crate::audio::wav_mono16(&pcm, settings.tts_sample_rate))
    }
}

/// The media type without parameters, as aiohttp's `content_type`.
pub fn content_type(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

/// Splits a byte stream into lines the way aiohttp's `async for raw in response.content`
/// does (each line keeps its content up to and excluding `\n`).
#[derive(Default)]
pub struct LineSplitter {
    pending: Vec<u8>,
}

impl LineSplitter {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=index).collect();
            lines.push(line);
        }
        lines
    }

    /// The last line when the stream ends without a newline.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        (!self.pending.is_empty()).then(|| std::mem::take(&mut self.pending))
    }
}

/// One `data:` line of the speech.cpp SSE stream.
#[derive(Debug, PartialEq, Eq)]
pub enum SseEvent {
    Done,
    Audio(String),
    Error,
    Finished,
    Other,
}

pub fn parse_sse_line(raw: &[u8]) -> SseEvent {
    let line = String::from_utf8_lossy(raw);
    let line = line.trim();
    let Some(data) = line.strip_prefix("data:") else { return SseEvent::Other };
    let data = data.trim();
    if data == "[DONE]" {
        return SseEvent::Done;
    }
    let Ok(event) = serde_json::from_str::<Value>(data) else { return SseEvent::Other };
    match event.get("type").and_then(Value::as_str) {
        Some("speech.audio.delta") => {
            let audio = [event.get("delta"), event.get("audio")]
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .find(|value| !value.is_empty())
                .unwrap_or("");
            SseEvent::Audio(audio.to_string())
        }
        Some("error") | Some("speech.audio.error") => SseEvent::Error,
        Some("speech.audio.done") => SseEvent::Finished,
        _ => SseEvent::Other,
    }
}

/// `json.dumps(value, ensure_ascii=False)` with Python's default separators.
pub fn py_json_dumps_ensure_ascii_false(value: &Value) -> String {
    let mut out = String::new();
    write_py_json(value, &mut out);
    out
}

fn write_py_json(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&serde_json::to_string(key).expect("string"));
                out.push_str(": ");
                write_py_json(item, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_py_json(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).expect("scalar")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_lines_decode_like_python() {
        assert_eq!(parse_sse_line(b"data: [DONE]\n"), SseEvent::Done);
        assert_eq!(
            parse_sse_line(br#"data: {"type":"speech.audio.delta","delta":"AAA="}"#),
            SseEvent::Audio("AAA=".into())
        );
        assert_eq!(
            parse_sse_line(br#"data: {"type":"speech.audio.delta","delta":"","audio":"AQI="}"#),
            SseEvent::Audio("AQI=".into())
        );
        assert_eq!(parse_sse_line(br#"data: {"type":"speech.audio.error"}"#), SseEvent::Error);
        assert_eq!(parse_sse_line(b"event: x"), SseEvent::Other);
        assert_eq!(parse_sse_line(b"data: not json"), SseEvent::Other);
    }

    #[test]
    fn line_splitter_handles_split_chunks() {
        let mut splitter = LineSplitter::default();
        assert!(splitter.push(b"data: a").is_empty());
        assert_eq!(splitter.push(b"bc\ndata: d\n"), vec![b"data: abc\n".to_vec(), b"data: d\n".to_vec()]);
        assert_eq!(splitter.finish(), None);
    }

    #[test]
    fn python_json_dumps_spacing() {
        let value = json!({"house_rules": "宅配", "reception": {"a": [1, 2]}});
        assert_eq!(
            py_json_dumps_ensure_ascii_false(&value),
            r#"{"house_rules": "宅配", "reception": {"a": [1, 2]}}"#
        );
    }
}
