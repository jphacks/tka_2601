//! speech.cpp TTS client (port of `voice/speech_tts.py` `SpeechCppTTS`).
//!
//! One call synthesizes one reply text (already passed through
//! [`super::text::TtsTextFilter`]): it is split with [`split_sentences`], each sentence is
//! one `POST /v1/audio/speech`, each sentence's audio gets [`trim_delayed_audio_tail`], and
//! the result is the concatenation (mono s16le at `tts_sample_rate`).
//!
//! Before any PCM reaches a consumer, the whole call is retried like livekit's `ChunkedStream` with the session's default
//! `APIConnectOptions()` (3 retries after 0.1 s, 2 s, 2 s, only for retryable errors).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::sync::{mpsc, OnceCell};

use monban_policy::agent_rules::{DOOR_GREETING, RECEPTION_GREETING};

use super::error::{livekit_retry_interval, ClientError, Service};
use super::text::{py_strip, sentence_ending_runs, split_sentences, trim_delayed_audio_tail};
use crate::config::Settings;
use crate::services::{content_type, LineSplitter};

/// aiohttp `ClientTimeout(total=45, connect=conn_options.timeout, sock_read=30)` with the
/// default `APIConnectOptions().timeout` of 10 s.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(45);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// `APIConnectOptions()` defaults used for the session's TTS.
const MAX_RETRY: usize = 3;
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Silence livekit-agents appends to a reply spoken as one `StreamAdapter` token, in
/// samples at the TTS rate: the TTS `AudioEmitter` and the `StreamAdapter` around it each
/// end their segment with a 10 ms zero "final" marker frame (`sample_rate // 100`
/// samples). The adapter's blingfire tokenizer merges sentences until a token has at least
/// 20 code points; each token is one synthesize call followed by one marker, and the reply
/// ends with one more (see [`livekit_marker_bytes`]).
pub fn livekit_end_marker_samples(sample_rate: u32) -> usize {
    2 * (sample_rate as usize / 100)
}

/// Bytes of one livekit 10 ms zero marker frame (`sample_rate // 100` samples, s16le).
/// livekit adds one after each `StreamAdapter` token's synthesis and one more at the end
/// of the reply.
pub fn livekit_marker_bytes(sample_rate: u32) -> usize {
    (sample_rate as usize / 100) * 2
}

#[derive(Default)]
struct FixedGreetings {
    door: OnceCell<Vec<u8>>,
    reception: OnceCell<Vec<u8>>,
    prewarm_scheduled: AtomicBool,
}

/// Clones share the two fixed greetings and the exact immutable audio settings.
/// A different client/settings instance gets its own cache, never another voice's PCM.
#[derive(Clone)]
pub struct SpeechCppTts {
    http: reqwest::Client,
    settings: Arc<Settings>,
    greetings: Arc<FixedGreetings>,
}

impl SpeechCppTts {
    /// The HTTP client (a clone shares its connection pool), for the call-start warm-up.
    pub fn http(&self) -> reqwest::Client {
        self.http.clone()
    }

    pub fn new(settings: Arc<Settings>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .expect("HTTP client for TTS");
        Self { http, settings, greetings: Arc::default() }
    }

    /// Fill only the two standard greeting entries without delaying server startup.
    /// Calls arriving during prewarm join the same single-flight initialization.
    /// Failures/timeouts leave the entry empty so an on-demand call can retry.
    pub fn schedule_greeting_prewarm(&self) {
        if !self.settings.warmup_enabled {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        if self.greetings.prewarm_scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let tts = self.clone();
        runtime.spawn(async move {
            // Serial requests also avoid two cold syntheses competing for one TTS worker.
            let limit = Duration::from_secs_f64(tts.settings.warmup_timeout_seconds);
            for text in [DOOR_GREETING, RECEPTION_GREETING] {
                match tokio::time::timeout(limit, tts.synthesize(text)).await {
                    Ok(Ok(_)) => {},
                    Ok(Err(error)) => tracing::warn!("fixed greeting prewarm failed: {error}"),
                    Err(_) => tracing::warn!("fixed greeting prewarm timed out"),
                }
            }
        });
    }

    /// The PCM sample rate of [`synthesize`](Self::synthesize)'s output.
    pub fn sample_rate(&self) -> u32 {
        self.settings.tts_sample_rate
    }

    /// The JSON body for one sentence.
    pub fn request_body(&self, sentence: &str) -> Value {
        speech_body(&self.settings, sentence)
    }

    /// Synthesize one reply: mono s16le PCM at [`sample_rate`](Self::sample_rate). Empty
    /// for a blank text.
    pub async fn synthesize(&self, text: &str) -> Result<Vec<u8>, ClientError> {
        self.synthesize_to(text, None).await
    }

    pub(crate) async fn synthesize_to(
        &self,
        text: &str,
        tx: Option<&mpsc::Sender<Vec<u8>>>,
    ) -> Result<Vec<u8>, ClientError> {
        let entry = match text {
            DOOR_GREETING => Some(&self.greetings.door),
            RECEPTION_GREETING => Some(&self.greetings.reception),
            _ => None,
        };
        if let Some(entry) = entry {
            let started = Instant::now();
            let cache_hit = entry.get().is_some();
            let mut streamed_by_this_call = false;
            let result = entry.get_or_try_init(|| async {
                streamed_by_this_call = true;
                self.synthesize_uncached(text, tx).await
            }).await;
            if let (Some(tx), Ok(pcm)) = (tx, &result) {
                if !streamed_by_this_call {
                    send_audio(tx, pcm).await?;
                }
            }
            // The caller with a sink already owns its PCM; avoid cloning the cached reply.
            let result = result.map(|pcm| if tx.is_none() { pcm.clone() } else { Vec::new() });
            tracing::info!(cache_hit, elapsed_ms = started.elapsed().as_millis() as u64,
                ok = result.is_ok(), "tts_fixed_greeting_complete");
            return result;
        }
        self.synthesize_uncached(text, tx).await
    }

    async fn synthesize_uncached(&self, text: &str, tx: Option<&mpsc::Sender<Vec<u8>>>) -> Result<Vec<u8>, ClientError> {
        let mut sentences = split_sentences(text);
        let stripped = py_strip(text);
        if sentences.is_empty() && !stripped.is_empty() {
            sentences = vec![stripped.to_string()];
        }
        tracing::info!(text_chars = text.chars().count(), sentences = sentences.len(), "tts_text_split");
        let mut attempt = 0;
        loop {
            let mut sent = false;
            match self.synthesize_once(&sentences, tx, &mut sent).await {
                Ok(pcm) if pcm.is_empty() && !stripped.is_empty() => {
                    // ChunkedStream: "no audio frames were pushed" (a retryable APIError).
                    let error = ClientError::protocol(Service::Tts, "no audio frames were pushed");
                    if attempt >= MAX_RETRY {
                        return Err(error);
                    }
                }
                Ok(pcm) => return Ok(pcm),
                Err(error) => {
                    if sent || !error.retryable() || attempt >= MAX_RETRY {
                        return Err(error);
                    }
                    tracing::warn!("failed to synthesize speech: {error}, retrying");
                }
            }
            tokio::time::sleep(livekit_retry_interval(attempt, RETRY_INTERVAL)).await;
            attempt += 1;
        }
    }

    async fn synthesize_once(
        &self,
        sentences: &[String],
        tx: Option<&mpsc::Sender<Vec<u8>>>,
        sent: &mut bool,
    ) -> Result<Vec<u8>, ClientError> {
        let mut audio = Vec::new();
        for sentence in sentences {
            let mut body = SentenceAudio::new(self.settings.tts_sample_rate, sentence, tx, sent);
            self.read_sentence(sentence, &mut body).await?;
            let pcm = body.finish().await?;
            audio.extend(pcm);
        }
        Ok(audio)
    }

    async fn read_sentence(&self, sentence: &str, body: &mut SentenceAudio<'_>) -> Result<(), ClientError> {
        let settings = &self.settings;
        let started = Instant::now();
        tracing::info!(text_chars = sentence.chars().count(), "tts_api_post");
        let error = |e| ClientError::from_reqwest(Service::Tts, e);
        let response = self
            .http
            .post(format!("{}/v1/audio/speech", settings.tts_base_url))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", settings.tts_api_key))
            .json(&self.request_body(sentence))
            .timeout(TOTAL_TIMEOUT)
            .send()
            .await
            .map_err(error)?;
        let status = response.status().as_u16();
        tracing::info!(status, elapsed_ms = started.elapsed().as_millis() as u64, "tts_api_headers");
        if status != 200 {
            return Err(ClientError::Status { service: Service::Tts, status });
        }
        let media_type = content_type(&response);
        let mut stream = response.bytes_stream();
        let mut first_pcm = false;
        match media_type.as_str() {
            "text/event-stream" => {
                let mut lines = LineSplitter::default();
                let mut ended = false;
                let mut completed = false;
                'read: while !ended {
                    let batch = match stream.next().await {
                        Some(chunk) => lines.push(&chunk.map_err(error)?),
                        None => {
                            ended = true;
                            lines.finish().into_iter().collect()
                        }
                    };
                    for raw in batch {
                        match parse_speech_event(&raw)? {
                            SpeechEvent::Skip => {}
                            SpeechEvent::Done => {
                                completed = true;
                                break 'read;
                            }
                            SpeechEvent::Audio(audio) => {
                                if !first_pcm && !audio.is_empty() {
                                    first_pcm = true;
                                    tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, "tts_first_pcm");
                                }
                                body.push(&audio).await?;
                            }
                        }
                    }
                }
                if !completed {
                    return Err(ClientError::protocol(Service::Tts, "speech stream ended before completion"));
                }
            }
            "audio/pcm" | "application/octet-stream" => {
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(error)?;
                    if !first_pcm && !chunk.is_empty() {
                        first_pcm = true;
                        tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, "tts_first_pcm");
                    }
                    body.push(&chunk).await?;
                }
            }
            _ => {
                return Err(ClientError::protocol(Service::Tts, "unsupported content type"));
            }
        }
        if !body.pcm.len().is_multiple_of(2) {
            return Err(ClientError::protocol(Service::Tts, "incomplete PCM sample"));
        }
        tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, pcm_bytes = body.pcm.len(), "tts_pcm_complete");
        Ok(())
    }
}

async fn send_audio(tx: &mpsc::Sender<Vec<u8>>, pcm: &[u8]) -> Result<(), ClientError> {
    if !pcm.is_empty() {
        tx.send(pcm.to_vec()).await.map_err(|_| not_retryable("audio consumer closed"))?;
    }
    Ok(())
}

/// Emit only PCM which cannot be removed by the legacy delayed-tail trimmer. A frame with
/// RMS >= 32768 * .006 is active at every possible final threshold. Shorter gaps cannot
/// trigger the one-second rule. An ambiguous long gap and its suffix await the final trim.
struct SentenceAudio<'a> {
    rate: u32,
    sentence: &'a str,
    tx: Option<&'a mpsc::Sender<Vec<u8>>>,
    sent: &'a mut bool,
    pcm: Vec<u8>,
    emitted: usize,
    scanned_frames: usize,
    gap_frames: usize,
    possible_tail: bool,
}

impl<'a> SentenceAudio<'a> {
    fn new(rate: u32, sentence: &'a str, tx: Option<&'a mpsc::Sender<Vec<u8>>>, sent: &'a mut bool) -> Self {
        Self { rate, sentence, tx, sent, pcm: Vec::new(), emitted: 0, scanned_frames: 0, gap_frames: 0, possible_tail: false }
    }

    async fn publish_to(&mut self, end: usize) -> Result<(), ClientError> {
        if let Some(tx) = self.tx {
            if self.emitted < end {
                send_audio(tx, &self.pcm[self.emitted..end]).await?;
                *self.sent = true;
                self.emitted = end;
            }
        }
        Ok(())
    }

    async fn push(&mut self, bytes: &[u8]) -> Result<(), ClientError> {
        self.pcm.extend_from_slice(bytes);
        if self.tx.is_none() || self.possible_tail {
            return Ok(());
        }
        if sentence_ending_runs(self.sentence) > 1 {
            return self.publish_to(self.pcm.len() / 2 * 2).await;
        }
        let samples = (self.rate as usize / 50).max(1);
        let frame = samples * 2;
        let silence_frames = self.rate as usize / samples;
        let keep_frames = (0.18 * f64::from(self.rate) / samples as f64) as usize;
        let mut safe = self.emitted;
        for bytes in self.pcm[self.scanned_frames * frame..].chunks_exact(frame) {
            let energy: i64 = bytes.chunks_exact(2).map(|s| {
                let value = i64::from(i16::from_le_bytes([s[0], s[1]]));
                value * value
            }).sum();
            self.scanned_frames += 1;
            if energy as f64 >= samples as f64 * (32768.0_f64 * 0.006).powi(2) {
                self.gap_frames = 0;
            } else {
                self.gap_frames += 1;
            }
            safe = (self.scanned_frames - self.gap_frames.saturating_sub(keep_frames)) * frame;
            if self.gap_frames >= silence_frames {
                self.possible_tail = true;
                break;
            }
        }
        self.publish_to(safe).await
    }

    async fn finish(mut self) -> Result<Vec<u8>, ClientError> {
        let end = trim_delayed_audio_tail(&self.pcm, self.rate, self.sentence).len();
        debug_assert!(end >= self.emitted);
        self.publish_to(end).await?;
        self.pcm.truncate(end);
        Ok(self.pcm)
    }
}

/// The speech.cpp request body (`speech_tts.py`, also the warm-up probe).
pub(crate) fn speech_body(settings: &Settings, input: &str) -> Value {
    let mut body = json!({
        "model": settings.tts_model,
        "input": input,
        "voice": settings.tts_voice,
        "language": "ja",
        "seed": settings.tts_seed,
        "response_format": "pcm",
        "stream_format": "sse",
    });
    if !settings.tts_instructions.is_empty() {
        body["instructions"] = settings.tts_instructions.clone().into();
    }
    body
}

#[derive(Debug)]
enum SpeechEvent {
    Skip,
    Done,
    Audio(Vec<u8>),
}

fn not_retryable(detail: &str) -> ClientError {
    ClientError::Protocol { service: Service::Tts, detail: detail.to_string(), retryable: false }
}

/// One line of the speech.cpp SSE stream, as `SpeechCppStream._run` reads it. Invalid JSON
/// and invalid base64 raise plain Python exceptions there, which livekit does not retry.
fn parse_speech_event(raw: &[u8]) -> Result<SpeechEvent, ClientError> {
    let line = String::from_utf8_lossy(raw);
    let line = py_strip(&line);
    let Some(data) = line.strip_prefix("data:") else { return Ok(SpeechEvent::Skip) };
    let data = py_strip(data);
    if data == "[DONE]" {
        return Ok(SpeechEvent::Done);
    }
    let event: Value = serde_json::from_str(data).map_err(|_| not_retryable("invalid speech event JSON"))?;
    let Some(event) = event.as_object() else { return Err(not_retryable("speech event is not an object")) };
    match event.get("type").and_then(Value::as_str) {
        Some("speech.audio.delta") => {
            // Python: event.get("delta") or event.get("audio") or ""
            let encoded = [event.get("delta"), event.get("audio")]
                .into_iter()
                .flatten()
                .find(|value| py_truthy(value))
                .cloned()
                .unwrap_or(Value::String(String::new()));
            let Some(encoded) = encoded.as_str() else {
                return Err(not_retryable("speech audio is not a string"));
            };
            let audio = base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| not_retryable("invalid base64 audio"))?;
            if audio.len() % 2 != 0 {
                return Err(ClientError::protocol(Service::Tts, "incomplete PCM sample"));
            }
            Ok(SpeechEvent::Audio(audio))
        }
        Some("error") | Some("speech.audio.error") => {
            Err(ClientError::protocol(Service::Tts, "speech synthesis failed"))
        }
        Some("speech.audio.done") => Ok(SpeechEvent::Done),
        _ => Ok(SpeechEvent::Skip),
    }
}

fn py_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_events() {
        assert!(matches!(parse_speech_event(b"data: [DONE]\n").unwrap(), SpeechEvent::Done));
        assert!(matches!(parse_speech_event(b": ping\n").unwrap(), SpeechEvent::Skip));
        assert!(matches!(
            parse_speech_event(br#"data: {"type": "speech.audio.done"}"#).unwrap(),
            SpeechEvent::Done
        ));
        match parse_speech_event(br#"data: {"type": "speech.audio.delta", "delta": "", "audio": "AQA="}"#).unwrap() {
            SpeechEvent::Audio(audio) => assert_eq!(audio, vec![1, 0]),
            _ => panic!("expected audio"),
        }
        let odd = parse_speech_event(br#"data: {"type": "speech.audio.delta", "delta": "AQ=="}"#);
        assert!(odd.unwrap_err().retryable());
        assert!(!parse_speech_event(b"data: {oops").unwrap_err().retryable());
        assert!(parse_speech_event(br#"data: {"type": "error"}"#).unwrap_err().retryable());
    }

    #[test]
    fn end_markers() {
        assert_eq!(livekit_end_marker_samples(16000), 320);
        assert_eq!(livekit_end_marker_samples(48000), 960);
    }
}
