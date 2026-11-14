//! OpenAI-compatible ASR client (port of `openai.STT` as built by `voice/agent.py` `_stt()`
//! and called by `relay/agent.py` `DeviceAgent.recognize`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::error::{livekit_retry_interval, ClientError, Service};
use crate::config::Settings;

/// `voice/agent.py` `ASR_PROMPT`, sent only to Qwen ASR models.
pub const ASR_PROMPT: &str = "玄関インターホンでの会話です。宅配便、配達、宅配ボックス、玄関前、置き配、荷物、写真、暗証番号、営業、勧誘などの語が出ます。日本語で聞こえた通りに文字起こししてください。";

/// The utterance sample rate (`rtc.AudioFrame(pcm, 16000, 1, ...)`).
pub const INPUT_SAMPLE_RATE: u32 = 16_000;

/// `httpx.Timeout(30, connect=conn_options.timeout)` with `APIConnectOptions(timeout=45)`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// `APIConnectOptions(max_retry=1, retry_interval=1, timeout=45)`; the openai client itself
/// has `max_retries=0`.
const MAX_RETRY: usize = 1;
const RETRY_INTERVAL: Duration = Duration::from_secs(1);

pub struct SttClient {
    http: reqwest::Client,
    settings: Arc<Settings>,
}

impl SttClient {
    pub fn new(settings: Arc<Settings>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .expect("HTTP client for ASR");
        Self { http, settings }
    }

    /// The text form fields in the order the openai SDK sends them (the file comes last).
    pub fn form_fields(&self) -> Vec<(&'static str, String)> {
        let mut fields = vec![("model", self.settings.asr_model.clone()), ("language", "ja".to_string())];
        if self.settings.asr_model.starts_with("Qwen") {
            fields.push(("prompt", ASR_PROMPT.to_string()));
        }
        fields.push(("response_format", "json".to_string()));
        fields
    }

    /// Transcribe one utterance of mono s16le PCM at 16 kHz. Returns the response's `text`
    /// as is (the caller strips it, as `DeviceAgent.recognize` does).
    pub async fn transcribe(&self, pcm: &[u8]) -> Result<String, ClientError> {
        let wav = crate::audio::wav_mono16(pcm, INPUT_SAMPLE_RATE);
        let mut attempt = 0;
        loop {
            match self.transcribe_once(wav.clone()).await {
                Ok(text) => return Ok(text),
                Err(error) => {
                    if !error.retryable() || attempt >= MAX_RETRY {
                        return Err(error);
                    }
                    tracing::warn!("failed to recognize speech: {error}, retrying");
                }
            }
            tokio::time::sleep(livekit_retry_interval(attempt, RETRY_INTERVAL)).await;
            attempt += 1;
        }
    }

    async fn transcribe_once(&self, wav: Vec<u8>) -> Result<String, ClientError> {
        let error = |e| ClientError::from_reqwest(Service::Asr, e);
        let mut form = reqwest::multipart::Form::new();
        for (name, value) in self.form_fields() {
            form = form.text(name, value);
        }
        let file = reqwest::multipart::Part::bytes(wav)
            .file_name("file.wav")
            .mime_str("audio/wav")
            .expect("valid media type");
        form = form.part("file", file);
        let response = self
            .http
            .post(format!("{}/v1/audio/transcriptions", self.settings.asr_base_url))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", self.settings.asr_api_key))
            .multipart(form)
            .send()
            .await
            .map_err(error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ClientError::Status { service: Service::Asr, status: status.as_u16() });
        }
        let body = response.bytes().await.map_err(error)?;
        let data: Value = serde_json::from_slice(&body)
            .map_err(|_| ClientError::protocol(Service::Asr, "invalid transcription JSON"))?;
        data.get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ClientError::protocol(Service::Asr, "transcription has no text"))
    }
}
