//! Streaming OpenAI-compatible chat completions (port of `openai.LLM` as built by
//! `voice/agent.py` `_llm()`, with livekit-agents 1.8.8 `inference/llm.py` `LLMStream`).
//!
//! * Body: what the openai SDK sends for `_llm()` (`model`, `messages`, `tools` when any,
//!   `tool_choice` when given, `stream`, `stream_options`, `temperature`,
//!   `reasoning_effort`, and `extra_body`'s `max_tokens` and `keep_alive`).
//! * Parsing: `LLMStream._parse_choice` (tool call assembly, thinking-token removal).
//! * Retries: the openai client's `max_retries=1` around the request, and the session's
//!   `APIConnectOptions(max_retry=1, retry_interval=1)` around the whole attempt. livekit
//!   retries only while nothing has been output; here only failures before the first event
//!   (that is, before [`LlmClient::stream`] returns) are retried.
//! * Timeouts: the session passes `timeout=llm_timeout_seconds` per request, which replaces
//!   the client's `httpx.Timeout(llm_timeout_seconds, connect=5)`; so connect, each write
//!   and each read wait at most `llm_timeout_seconds` and there is no total limit.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::{Stream, StreamExt};
use rand::Rng;
use serde_json::{json, Map, Value};

use super::error::{livekit_retry_interval, ClientError, Service};
use crate::config::Settings;
use crate::services::LineSplitter;

const TEMPERATURE: f64 = 0.15;
const REASONING_EFFORT: &str = "none";
/// Session `APIConnectOptions(max_retry=1, retry_interval=1, ...)`.
const SESSION_MAX_RETRY: usize = 1;
const SESSION_RETRY_INTERVAL: Duration = Duration::from_secs(1);
/// openai SDK `max_retries=1`, `INITIAL_RETRY_DELAY`, `MAX_RETRY_AFTER_DELAY`.
const SDK_MAX_RETRIES: usize = 1;
const SDK_INITIAL_RETRY_DELAY: f64 = 0.5;
const SDK_MAX_RETRY_DELAY: f64 = 8.0;
const SDK_MAX_RETRY_AFTER: f64 = 120.0;

/// One piece of the model's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmEvent {
    /// Visible text (thinking tokens removed). Never empty.
    Text(String),
    /// A complete function call; `arguments` is the raw JSON text the model produced.
    ToolCall { call_id: String, name: String, arguments: String },
}

pub type LlmEventStream = Pin<Box<dyn Stream<Item = anyhow::Result<LlmEvent>> + Send>>;

pub struct LlmClient {
    http: reqwest::Client,
    settings: Arc<Settings>,
}

impl LlmClient {
    /// The HTTP client (a clone shares its connection pool), for the call-start warm-up.
    pub fn http(&self) -> reqwest::Client {
        self.http.clone()
    }

    pub fn new(settings: Arc<Settings>) -> Self {
        let timeout = Duration::from_secs_f64(settings.llm_timeout_seconds);
        let http = reqwest::Client::builder()
            .connect_timeout(timeout)
            .read_timeout(timeout)
            .build()
            .expect("HTTP client for the LLM");
        Self { http, settings }
    }

    /// The request body. `tools` is omitted when empty, `tool_choice` when `None`.
    pub fn request_body(&self, messages: Vec<Value>, tools: Vec<Value>, tool_choice: Option<&str>) -> Value {
        let settings = &self.settings;
        let mut body = Map::new();
        body.insert("model".into(), settings.llm_model.clone().into());
        body.insert("messages".into(), Value::Array(messages));
        if !tools.is_empty() {
            body.insert("tools".into(), Value::Array(tools));
        }
        if let Some(choice) = tool_choice {
            body.insert("tool_choice".into(), choice.into());
        }
        body.insert("stream".into(), true.into());
        body.insert("stream_options".into(), json!({"include_usage": true}));
        body.insert("temperature".into(), TEMPERATURE.into());
        body.insert("reasoning_effort".into(), REASONING_EFFORT.into());
        body.insert("max_tokens".into(), settings.llm_max_tokens.into());
        body.insert("keep_alive".into(), settings.llm_keep_alive.clone().into());
        Value::Object(body)
    }

    /// Start a completion. Returns once the first event arrived (or the reply ended
    /// without any); failures up to that point are retried, later ones end the stream with
    /// an error. Errors are [`ClientError`]s inside `anyhow::Error`.
    pub async fn stream(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
        tool_choice: Option<&str>,
    ) -> anyhow::Result<LlmEventStream> {
        let body = self.request_body(messages, tools, tool_choice);
        let mut attempt = 0;
        loop {
            match self.start(&body).await {
                Ok(started) => return Ok(started.into_stream()),
                Err(error) => {
                    if !error.retryable() || attempt >= SESSION_MAX_RETRY {
                        return Err(error.into());
                    }
                    tracing::warn!("failed to generate LLM completion: {error}, retrying");
                }
            }
            tokio::time::sleep(livekit_retry_interval(attempt, SESSION_RETRY_INTERVAL)).await;
            attempt += 1;
        }
    }

    async fn start(&self, body: &Value) -> Result<Started, ClientError> {
        let response = self.send(body).await?;
        let model = self.settings.llm_model.clone();
        let mut reader = Reader {
            bytes: Box::pin(response.bytes_stream()),
            lines: LineSplitter::default(),
            sse: SseDecoder::default(),
            parser: ChunkParser::new(&model),
            pending: VecDeque::new(),
            done: false,
        };
        reader.fill().await?;
        Ok(Started { reader })
    }

    /// The openai SDK's request with its own retry (`max_retries=1`).
    async fn send(&self, body: &Value) -> Result<reqwest::Response, ClientError> {
        let mut retries_taken = 0;
        loop {
            let result = self
                .http
                .post(format!("{}/v1/chat/completions", self.settings.ollama_base_url))
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", self.settings.llm_api_key))
                .json(body)
                .send()
                .await;
            let retry_after = match result {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let retry_after = retry_after_seconds(response.headers());
                    if retries_taken >= SDK_MAX_RETRIES || !sdk_should_retry(status, response.headers(), retry_after) {
                        return Err(ClientError::Status { service: Service::Llm, status });
                    }
                    retry_after
                }
                Err(error) => {
                    if retries_taken >= SDK_MAX_RETRIES {
                        return Err(ClientError::from_reqwest(Service::Llm, error));
                    }
                    None
                }
            };
            tokio::time::sleep(sdk_retry_delay(retries_taken, retry_after)).await;
            retries_taken += 1;
        }
    }
}

/// openai `_parse_retry_after_header` (numeric forms; the HTTP-date form is not parsed).
fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<f64> {
    for (name, divisor) in [("retry-after-ms", 1000.0), ("retry-after", 1.0)] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            if let Ok(delay) = value.trim().parse::<f64>() {
                return Some(delay / divisor);
            }
        }
    }
    None
}

/// openai `_should_retry`.
fn sdk_should_retry(status: u16, headers: &reqwest::header::HeaderMap, retry_after: Option<f64>) -> bool {
    if retry_after.is_some_and(|delay| delay.is_finite() && delay > SDK_MAX_RETRY_AFTER) {
        return false;
    }
    match headers.get("x-should-retry").and_then(|value| value.to_str().ok()) {
        Some("true") => return true,
        Some("false") => return false,
        _ => {}
    }
    matches!(status, 408 | 409 | 429) || status >= 500
}

/// openai `_calculate_retry_timeout`.
fn sdk_retry_delay(retries_taken: usize, retry_after: Option<f64>) -> Duration {
    if let Some(delay) = retry_after.filter(|delay| delay.is_finite() && *delay > 0.0 && *delay <= SDK_MAX_RETRY_AFTER) {
        return Duration::from_secs_f64(delay);
    }
    let base = (SDK_INITIAL_RETRY_DELAY * 2f64.powi(retries_taken as i32)).min(SDK_MAX_RETRY_DELAY);
    let jitter = 1.0 - 0.25 * rand::thread_rng().gen::<f64>();
    Duration::from_secs_f64((base * jitter).max(0.0))
}

struct Started {
    reader: Reader,
}

impl Started {
    fn into_stream(self) -> LlmEventStream {
        Box::pin(futures::stream::unfold(Some(self.reader), |state| async move {
            let mut reader = state?;
            if reader.pending.is_empty() && !reader.done {
                if let Err(error) = reader.fill().await {
                    return Some((Err(anyhow::Error::new(error)), None));
                }
            }
            let event = reader.pending.pop_front()?;
            Some((Ok(event), Some(reader)))
        }))
    }
}

type ByteStream = Pin<Box<dyn Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>;

struct Reader {
    bytes: ByteStream,
    lines: LineSplitter,
    sse: SseDecoder,
    parser: ChunkParser,
    pending: VecDeque<LlmEvent>,
    done: bool,
}

impl Reader {
    /// Read until at least one event is pending or the stream is over.
    async fn fill(&mut self) -> Result<(), ClientError> {
        while self.pending.is_empty() && !self.done {
            let lines = match self.bytes.next().await {
                Some(chunk) => {
                    let chunk = chunk.map_err(|error| ClientError::from_reqwest(Service::Llm, error))?;
                    self.lines.push(&chunk)
                }
                None => {
                    // A last event without its blank line is dropped, as by the openai SDK.
                    self.done = true;
                    return Ok(());
                }
            };
            for line in lines {
                let Some(data) = self.sse.line(&line) else { continue };
                if data.starts_with("[DONE]") {
                    self.done = true;
                    break;
                }
                let chunk: Value = serde_json::from_str(&data)
                    .map_err(|_| ClientError::protocol(Service::Llm, "invalid completion chunk JSON"))?;
                if chunk.get("error").is_some_and(truthy) {
                    return Err(ClientError::protocol(Service::Llm, "error during streaming"));
                }
                self.pending.extend(self.parser.push_chunk(&chunk)?);
            }
        }
        Ok(())
    }
}

/// The parts of the openai SDK's `SSEDecoder` the chat stream uses: returns the `data` of
/// each complete event (dispatched on a blank line).
#[derive(Default)]
struct SseDecoder {
    data: Vec<String>,
    has_fields: bool,
}

impl SseDecoder {
    fn line(&mut self, raw: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(raw);
        let line = text.trim_end_matches(['\n', '\r']);
        if line.is_empty() {
            if !self.has_fields {
                return None;
            }
            self.has_fields = false;
            return Some(std::mem::take(&mut self.data).join("\n"));
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => {
                self.data.push(value.to_string());
                self.has_fields = true;
            }
            "event" | "id" => self.has_fields = true,
            "retry" => {
                if value.parse::<u64>().is_ok() {
                    self.has_fields = true;
                }
            }
            _ => {}
        }
        None
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// `_MODEL_THINK_TAGS`, else `<think>`/`</think>`.
fn think_tags(model: &str) -> (&'static str, &'static str) {
    match model {
        "google/gemma-4-31b-it" => ("<|channel>thought", "<channel|>"),
        _ => ("<think>", "</think>"),
    }
}

/// livekit `llm_utils.ThinkingTokenFilter` / `strip_thinking_tokens`.
#[derive(Debug, Clone)]
pub struct ThinkingFilter {
    start_tag: String,
    end_tag: String,
    buffer: String,
    in_thought: bool,
}

/// `_partial_marker_length`: the longest proper prefix of `marker` that `content` ends with
/// (in code points).
fn partial_marker_length(content: &str, marker: &str) -> usize {
    let content_len = content.chars().count();
    let marker_chars: Vec<char> = marker.chars().collect();
    let limit = content_len.min(marker_chars.len().saturating_sub(1));
    (1..=limit)
        .filter(|length| content.ends_with(&marker_chars[..*length].iter().collect::<String>()))
        .max()
        .unwrap_or(0)
}

/// Split off the last `count` code points.
fn split_last_chars(text: &str, count: usize) -> (&str, &str) {
    if count == 0 {
        return (text, "");
    }
    let index = text.char_indices().rev().nth(count - 1).map_or(0, |(index, _)| index);
    text.split_at(index)
}

impl ThinkingFilter {
    pub fn new(model: &str) -> Self {
        let (start, end) = think_tags(model);
        Self { start_tag: start.into(), end_tag: end.into(), buffer: String::new(), in_thought: false }
    }

    /// `strip_thinking_tokens(content, state, final=final)`.
    pub fn strip(&mut self, content: Option<&str>, final_chunk: bool) -> Option<String> {
        if let Some(content) = content {
            self.buffer.push_str(content);
        }
        let mut visible = String::new();
        while !self.buffer.is_empty() {
            if self.in_thought {
                match self.buffer.find(&self.end_tag) {
                    None => {
                        let keep = partial_marker_length(&self.buffer, &self.end_tag);
                        self.buffer = split_last_chars(&self.buffer, keep).1.to_string();
                        break;
                    }
                    Some(index) => {
                        self.buffer = self.buffer[index + self.end_tag.len()..].to_string();
                        self.in_thought = false;
                        continue;
                    }
                }
            }
            if let Some(index) = self.buffer.find(&self.start_tag) {
                visible.push_str(&self.buffer[..index]);
                self.buffer = self.buffer[index + self.start_tag.len()..].to_string();
                self.in_thought = true;
                continue;
            }
            let keep = partial_marker_length(&self.buffer, &self.start_tag);
            let (shown, kept) = split_last_chars(&self.buffer, keep);
            visible.push_str(shown);
            self.buffer = kept.to_string();
            break;
        }
        if final_chunk {
            if !self.in_thought {
                visible.push_str(&self.buffer);
            }
            self.buffer.clear();
            self.in_thought = false;
        }
        if !visible.is_empty() {
            Some(visible)
        } else if content == Some("") {
            Some(String::new())
        } else {
            None
        }
    }
}

/// `_flatten_delta_content`: a string, or the joined `text` of a list of content parts.
fn flatten_content(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(|part| match part {
                    Value::String(text) => Some(text.as_str()),
                    Value::Object(map) => map.get("text").and_then(Value::as_str),
                    _ => None,
                })
                .collect();
            (!texts.is_empty()).then(|| texts.concat())
        }
        _ => None,
    }
}

/// `LLMStream._parse_choice` over a stream of `chat.completion.chunk` objects.
#[derive(Debug, Clone)]
pub struct ChunkParser {
    thinking: ThinkingFilter,
    tool_call_id: Option<String>,
    function_name: Option<String>,
    raw_arguments: Option<String>,
    tool_index: Option<Value>,
}

impl ChunkParser {
    pub fn new(model: &str) -> Self {
        Self {
            thinking: ThinkingFilter::new(model),
            tool_call_id: None,
            function_name: None,
            raw_arguments: None,
            tool_index: None,
        }
    }

    /// Events from one parsed SSE chunk (usage-only chunks give none).
    pub fn push_chunk(&mut self, chunk: &Value) -> Result<Vec<LlmEvent>, ClientError> {
        let mut events = Vec::new();
        if let Some(choices) = chunk.get("choices").and_then(Value::as_array) {
            for choice in choices {
                events.extend(self.parse_choice(choice)?);
            }
        }
        Ok(events)
    }

    fn take_call(&mut self) -> LlmEvent {
        LlmEvent::ToolCall {
            call_id: self.tool_call_id.take().unwrap_or_default(),
            name: self.function_name.take().unwrap_or_default(),
            arguments: self.raw_arguments.take().unwrap_or_default(),
        }
    }

    fn has_call(&self) -> bool {
        self.tool_call_id.as_deref().is_some_and(|id| !id.is_empty())
    }

    /// A chunk carrying a tool call (and possibly content): livekit's generation handles
    /// the tool calls before the text.
    fn call_with_content(call: LlmEvent, content: Option<String>) -> Vec<LlmEvent> {
        let mut events = vec![call];
        events.extend(content.filter(|text| !text.is_empty()).map(LlmEvent::Text));
        events
    }

    fn parse_choice(&mut self, choice: &Value) -> Result<Vec<LlmEvent>, ClientError> {
        let Some(delta) = choice.get("delta").filter(|delta| !delta.is_null()) else {
            return Ok(Vec::new());
        };
        let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
        let has_finish = choice.get("finish_reason").is_some_and(|reason| !reason.is_null());
        let raw_content = flatten_content(delta.get("content"));
        let content = self.thinking.strip(raw_content.as_deref(), has_finish);

        if let Some(tools) = delta.get("tool_calls").and_then(Value::as_array) {
            for tool in tools {
                let Some(function) = tool.get("function").filter(|function| !function.is_null()) else {
                    continue;
                };
                let id = non_empty_str(tool.get("id"));
                let index = tool.get("index").cloned().unwrap_or(Value::Null);
                let mut closed = None;
                if self.has_call() && id.is_some() && Some(&index) != self.tool_index.as_ref() {
                    closed = Some(self.take_call());
                }
                if let Some(name) = non_empty_str(function.get("name")) {
                    self.tool_index = Some(index);
                    self.tool_call_id = tool.get("id").and_then(Value::as_str).map(str::to_string);
                    self.function_name = Some(name.to_string());
                    self.raw_arguments =
                        Some(function.get("arguments").and_then(Value::as_str).unwrap_or("").to_string());
                } else if let Some(arguments) = non_empty_str(function.get("arguments")) {
                    match self.raw_arguments.as_mut() {
                        Some(raw) => raw.push_str(arguments),
                        // Python: None += str raises, which livekit reports as a connection error.
                        None => return Err(ClientError::protocol(Service::Llm, "tool arguments before the tool name")),
                    }
                }
                if let Some(call) = closed {
                    return Ok(Self::call_with_content(call, content));
                }
            }
        }

        if matches!(finish_reason, Some("tool_calls") | Some("stop")) && self.has_call() {
            let call = self.take_call();
            return Ok(Self::call_with_content(call, content));
        }

        Ok(content.filter(|text| !text.is_empty()).map(LlmEvent::Text).into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(delta: Value, finish: Option<&str>) -> Value {
        json!({"id": "c", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
    }

    fn run(model: &str, chunks: &[Value]) -> Vec<LlmEvent> {
        let mut parser = ChunkParser::new(model);
        chunks.iter().flat_map(|c| parser.push_chunk(c).unwrap()).collect()
    }

    #[test]
    fn text_deltas() {
        let events = run("m", &[
            chunk(json!({"role": "assistant", "content": "はい、"}), None),
            chunk(json!({"content": ""}), None),
            chunk(json!({"content": "どうぞ。"}), None),
            chunk(json!({}), Some("stop")),
            json!({"id": "c", "choices": [], "usage": {"total_tokens": 3}}),
        ]);
        assert_eq!(events, vec![LlmEvent::Text("はい、".into()), LlmEvent::Text("どうぞ。".into())]);
    }

    #[test]
    fn tool_calls_are_assembled() {
        let events = run("m", &[
            chunk(json!({"tool_calls": [{"index": 0, "id": "a", "type": "function", "function": {"name": "f", "arguments": ""}}]}), None),
            chunk(json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"x\":"}}]}), None),
            chunk(json!({"tool_calls": [{"index": 0, "function": {"arguments": " 1}"}}]}), None),
            chunk(json!({"tool_calls": [{"index": 1, "id": "b", "function": {"name": "g", "arguments": "{}"}}]}), None),
            chunk(json!({}), Some("tool_calls")),
        ]);
        assert_eq!(
            events,
            vec![
                LlmEvent::ToolCall { call_id: "a".into(), name: "f".into(), arguments: "{\"x\": 1}".into() },
                LlmEvent::ToolCall { call_id: "b".into(), name: "g".into(), arguments: "{}".into() },
            ]
        );
    }

    #[test]
    fn finish_without_call_ends_nothing() {
        let events = run("m", &[chunk(json!({"content": "x"}), Some("length"))]);
        assert_eq!(events, vec![LlmEvent::Text("x".into())]);
    }

    #[test]
    fn arguments_before_name_fail() {
        let mut parser = ChunkParser::new("m");
        let result = parser.push_chunk(&chunk(json!({"tool_calls": [{"index": 0, "function": {"arguments": "{}"}}]}), None));
        assert!(result.unwrap_err().retryable());
    }

    #[test]
    fn thinking_is_removed_across_chunks() {
        let events = run("m", &[
            chunk(json!({"content": "<thi"}), None),
            chunk(json!({"content": "nk>考え中</th"}), None),
            chunk(json!({"content": "ink>はい"}), None),
            chunk(json!({"content": "。<"}), None),
            chunk(json!({"content": ""}), Some("stop")),
        ]);
        assert_eq!(
            events,
            vec![LlmEvent::Text("はい".into()), LlmEvent::Text("。".into()), LlmEvent::Text("<".into())]
        );
    }

    #[test]
    fn unfinished_thought_is_dropped() {
        let mut filter = ThinkingFilter::new("m");
        assert_eq!(filter.strip(Some("a<think>b"), false), Some("a".into()));
        assert_eq!(filter.strip(Some("c"), true), None);
        assert_eq!(filter.strip(Some(""), false), Some(String::new()));
    }

    #[test]
    fn gemma_tags() {
        let mut filter = ThinkingFilter::new("google/gemma-4-31b-it");
        assert_eq!(filter.strip(Some("<|channel>thought x<channel|>はい"), true), Some("はい".into()));
    }

    #[test]
    fn content_parts_are_flattened() {
        let events = run("m", &[chunk(json!({"content": [{"type": "text", "text": "a"}, "b", {"type": "x"}]}), None)]);
        assert_eq!(events, vec![LlmEvent::Text("ab".into())]);
    }

    #[test]
    fn sse_decoder_joins_data_lines() {
        let mut decoder = SseDecoder::default();
        assert_eq!(decoder.line(b": ping\n"), None);
        assert_eq!(decoder.line(b"data: {\"a\":\n"), None);
        assert_eq!(decoder.line(b"data:1}\r\n"), None);
        assert_eq!(decoder.line(b"\n").as_deref(), Some("{\"a\":\n1}"));
        assert_eq!(decoder.line(b"\n"), None);
    }

    #[test]
    fn sdk_retry_rules() {
        let headers = reqwest::header::HeaderMap::new();
        assert!(sdk_should_retry(500, &headers, None));
        assert!(sdk_should_retry(409, &headers, None));
        assert!(!sdk_should_retry(400, &headers, None));
        assert!(!sdk_should_retry(503, &headers, Some(300.0)));
        let delay = sdk_retry_delay(0, None);
        assert!(delay >= Duration::from_millis(375) && delay <= Duration::from_millis(500));
        assert_eq!(sdk_retry_delay(0, Some(2.0)), Duration::from_secs(2));
    }
}
