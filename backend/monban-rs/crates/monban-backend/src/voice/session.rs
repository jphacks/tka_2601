//! One call's conversation: what livekit-agents' `AgentSession` does in the v2 relay
//! (`relay/agent.py` `DeviceAgent`): `say` the greeting, then for each device-bounded
//! utterance run the agent's turn hook, its `llm_node`, the tool steps and TTS.
//!
//! Intended behavior adopted from the RTC path (Issue #79): the turn hook runs before every
//! reply, model tool calls get their arguments, and `end_call` is decided from the reply
//! being sent (the Python v2 path read the previous reply).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures::StreamExt;
use rand::RngCore;
use serde_json::Value;

use super::agents::{Agent, ChatModel, NodeEvent};
use super::chat::{py_json_dumps_ascii, ChatContext, ChatItem, Role};
use crate::relay::OutputSink;

/// livekit's `max_tool_steps` default.
pub const MAX_TOOL_STEPS: u32 = 3;
pub const OUTPUT_FRAME_BYTES: usize = 640;

/// Streaming `filter_markdown` + `filter_emoji`.
pub trait TextFilter: Send {
    fn push(&mut self, chunk: &str) -> String;
    fn finish(&mut self) -> String;
}

/// TTS output rate to the device's 16 kHz, keeping state across sentences.
pub trait Resampler: Send {
    fn process(&mut self, pcm: &[u8]) -> Vec<u8>;
    fn flush(&mut self) -> Vec<u8>;
}

#[async_trait::async_trait]
pub trait SpeechBackend: Send + Sync {
    fn text_filter(&self) -> Box<dyn TextFilter>;
    fn resampler(&self) -> Box<dyn Resampler>;
    /// PCM at the TTS rate for one sentence, with the delayed tail trimmed.
    async fn synthesize(&self, sentence: &str) -> anyhow::Result<Vec<u8>>;
    async fn synthesize_to(&self, sentence: &str, tx: tokio::sync::mpsc::Sender<Vec<u8>>) -> anyhow::Result<()> {
        tx.send(self.synthesize(sentence).await?).await?;
        Ok(())
    }
    /// Zero PCM at the TTS rate that livekit puts after each synthesized segment
    /// (each StreamAdapter token, and once more at the end of the reply).
    fn segment_marker(&self) -> Vec<u8> {
        Vec::new()
    }
}

#[async_trait::async_trait]
pub trait Recognizer: Send + Sync {
    async fn recognize(&self, pcm: Vec<u8>) -> anyhow::Result<String>;
}

const ENDINGS: &str = "。！？!?";
const CLOSERS: &str = "」』】）》)]}";

/// Take the first complete sentence of `pending` (as `_split_sentences` would cut it once
/// more text follows the punctuation), or None.
pub fn take_complete_sentence(pending: &mut String) -> Option<String> {
    loop {
        let chars: Vec<(usize, char)> = pending.char_indices().collect();
        let first = chars.iter().position(|(_, c)| ENDINGS.contains(*c))?;
        let mut end = first + 1;
        while end < chars.len() && ENDINGS.contains(chars[end].1) {
            end += 1;
        }
        while end < chars.len() && CLOSERS.contains(chars[end].1) {
            end += 1;
        }
        if end >= chars.len() {
            return None; // the run may continue in the next chunk
        }
        let byte_end = chars[end].0;
        let sentence = pending[..byte_end].trim().to_string();
        pending.replace_range(..byte_end, "");
        if !sentence.is_empty() {
            return Some(sentence);
        }
    }
}

/// `_split_sentences` for the text left at the end of a reply.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut pending = text.to_string();
    let mut out = Vec::new();
    while let Some(sentence) = take_complete_sentence(&mut pending) {
        out.push(sentence);
    }
    let rest = pending.trim();
    if !rest.is_empty() {
        // A trailing punctuation run with nothing after it is still one sentence.
        out.push(rest.to_string());
    }
    out
}

/// livekit's StreamAdapter batches sentences until a token reaches this many characters.
pub const MIN_TOKEN_CHARS: usize = 20;

/// Turns reply text into 640-byte device frames. Sentences are batched into tokens of at
/// least [`MIN_TOKEN_CHARS`] characters, each synthesized as soon as it is complete, the way
/// livekit's StreamAdapter feeds a non-streaming TTS.
struct Speaker<'a> {
    speech: &'a dyn SpeechBackend,
    sink: &'a dyn OutputSink,
    filter: Box<dyn TextFilter>,
    resampler: Box<dyn Resampler>,
    pending: String,
    token: String,
    pcm: Vec<u8>,
    samples: usize,
    synthesized: bool,
    started: Instant,
}

impl<'a> Speaker<'a> {
    fn new(speech: &'a dyn SpeechBackend, sink: &'a dyn OutputSink) -> Self {
        Self {
            speech,
            sink,
            filter: speech.text_filter(),
            resampler: speech.resampler(),
            pending: String::new(),
            token: String::new(),
            pcm: Vec::new(),
            samples: 0,
            synthesized: false,
            started: Instant::now(),
        }
    }

    async fn push(&mut self, chunk: &str) -> anyhow::Result<()> {
        let filtered = self.filter.push(chunk);
        self.pending.push_str(&filtered);
        while let Some(sentence) = take_complete_sentence(&mut self.pending) {
            self.add_sentence(&sentence).await?;
        }
        Ok(())
    }

    async fn add_sentence(&mut self, sentence: &str) -> anyhow::Result<()> {
        self.token.push_str(sentence);
        if self.token.chars().count() >= MIN_TOKEN_CHARS {
            self.say_token().await?;
        }
        Ok(())
    }

    async fn say_token(&mut self) -> anyhow::Result<()> {
        let token = std::mem::take(&mut self.token);
        if token.is_empty() {
            return Ok(());
        }
        tracing::info!(text_chars = token.chars().count(), elapsed_ms = self.started.elapsed().as_millis() as u64,
            "voice_token_ready");
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let speech = self.speech;
        // Both futures belong to the turn: a disconnect or write error also drops the HTTP body.
        let producer = speech.synthesize_to(&token, tx);
        let consumer = async {
            while let Some(pcm) = rx.recv().await {
                // A single SSE delta can contain seconds of audio. Convert incrementally even then.
                for piece in pcm.chunks(4096) {
                    self.resample_piece(piece).await?;
                }
            }
            Ok::<(), anyhow::Error>(())
        };
        tokio::try_join!(producer, consumer)?;
        self.synthesized = true;
        self.resample_piece(&speech.segment_marker()).await?;
        let flushed = self.resampler.flush();
        self.write(flushed).await
    }

    async fn resample_piece(&mut self, pcm: &[u8]) -> anyhow::Result<()> {
        let resample_started = Instant::now();
        let resampled = self.resampler.process(pcm);
        tracing::debug!(elapsed_us = resample_started.elapsed().as_micros() as u64,
            input_bytes = pcm.len(), output_bytes = resampled.len(), "voice_resample_complete");
        self.write(resampled).await
    }

    async fn write(&mut self, pcm: Vec<u8>) -> anyhow::Result<()> {
        self.pcm.extend_from_slice(&pcm);
        while self.pcm.len() >= OUTPUT_FRAME_BYTES {
            let frame: Vec<u8> = self.pcm.drain(..OUTPUT_FRAME_BYTES).collect();
            if self.samples == 0 {
                tracing::info!(elapsed_ms = self.started.elapsed().as_millis() as u64, "voice_first_frame_ready");
            }
            self.samples += frame.len() / 2;
            self.sink.write_audio(frame).await?;
        }
        Ok(())
    }

    /// Speak what is left; true when any audio went to the device.
    async fn finish(&mut self) -> anyhow::Result<bool> {
        let tail = self.filter.finish();
        self.pending.push_str(&tail);
        let rest = std::mem::take(&mut self.pending);
        for sentence in split_sentences(&rest) {
            self.add_sentence(&sentence).await?;
        }
        self.say_token().await?;
        if self.synthesized {
            let marker = self.speech.segment_marker();
            let resampled = self.resampler.process(&marker);
            self.write(resampled).await?;
        }
        let flushed = self.resampler.flush();
        self.write(flushed).await?;
        if !self.pcm.is_empty() {
            let frame = std::mem::take(&mut self.pcm);
            if self.samples == 0 {
                tracing::info!(elapsed_ms = self.started.elapsed().as_millis() as u64, "voice_first_frame_ready");
            }
            self.samples += frame.len() / 2;
            self.sink.write_audio(frame).await?;
        }
        Ok(self.samples > 0)
    }
}

fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

/// The state of one call.
pub struct Session {
    pub agent: Box<dyn Agent>,
    pub history: ChatContext,
    /// Set before `finish_audio`, which reads it for `output_end.end_call`.
    pub ends_call: Arc<AtomicBool>,
}

impl Session {
    pub fn new(agent: Box<dyn Agent>) -> Self {
        let mut history = ChatContext::default();
        history.set_instructions(&agent.instructions());
        Self { agent, history, ends_call: Arc::new(AtomicBool::new(false)) }
    }

    fn set_last_reply(&self, text: &str) {
        self.ends_call.store(text.contains("失礼いたします"), Ordering::SeqCst);
    }

    /// `session.say(greeting)`.
    pub async fn greet(&mut self, speech: &dyn SpeechBackend, sink: &dyn OutputSink) -> anyhow::Result<()> {
        let greeting = self.agent.greeting();
        self.set_last_reply(&greeting);
        let mut speaker = Speaker::new(speech, sink);
        speaker.push(&greeting).await?;
        if speaker.finish().await? {
            sink.finish_audio().await?;
            sink.wait_played().await?;
        }
        self.history.push_message(new_id("item"), Role::Assistant, greeting.clone());
        sink.transcript("ai", &greeting).await?;
        Ok(())
    }

    /// The turn hook, then `generate_reply(user_input=text)`.
    pub async fn reply(
        &mut self,
        text: &str,
        model: &dyn ChatModel,
        speech: &dyn SpeechBackend,
        sink: &dyn OutputSink,
    ) -> anyhow::Result<()> {
        if !self.agent.on_user_turn_completed(&self.history, text).await {
            return Ok(()); // StopResponse: the turn is ignored and not kept
        }
        self.history.push_message(new_id("item"), Role::User, text.to_string());
        let mut context = self.history.clone();
        context.set_instructions(&self.agent.instructions());

        let mut speaker = Speaker::new(speech, sink);
        let mut committed: Vec<ChatItem> = Vec::new();
        let mut replies: Vec<String> = Vec::new();
        let mut tool_choice: Option<&'static str> = None;
        let mut step = 1;
        loop {
            let group = new_id("step");
            // A model failure must not end the call: the agent answers with its own safe
            // reply instead. Audio and device errors still propagate.
            let mut model_failure: Option<anyhow::Error> = None;
            let mut stream = match self.agent.llm_node(context.clone(), tool_choice, model).await {
                Ok(stream) => stream,
                Err(error) => {
                    model_failure = Some(error);
                    futures::stream::empty().boxed()
                }
            };
            let mut text_out = String::new();
            let mut calls: Vec<(String, String, String)> = Vec::new();
            while let Some(event) = stream.next().await {
                match event {
                    Ok(NodeEvent::Text(chunk)) => {
                        text_out.push_str(&chunk);
                        speaker.push(&chunk).await?;
                    }
                    Ok(NodeEvent::ToolCall { call_id, name, arguments }) => calls.push((call_id, name, arguments)),
                    Err(error) => {
                        model_failure = Some(error);
                        break;
                    }
                }
            }
            if let Some(error) = model_failure.take() {
                tracing::warn!("model failed during a reply; using the agent's fallback: {error:#}");
                calls.clear(); // never run tool calls from a broken stream
                if text_out.is_empty() {
                    let fallback = self.agent.model_failure_reply(&context).await;
                    speaker.push(&fallback).await?;
                    text_out = fallback;
                }
                drop(stream);
                committed.push(ChatItem::Message { id: group.clone(), role: Role::Assistant, text: text_out.clone() });
                replies.push(text_out);
                break;
            }
            drop(stream);
            if !text_out.is_empty() {
                committed.push(ChatItem::Message { id: group.clone(), role: Role::Assistant, text: text_out.clone() });
                replies.push(text_out);
            }
            let mut tool_items = Vec::new();
            for (call_id, name, raw_arguments) in calls {
                let (arguments, result) = match serde_json::from_str::<Value>(&raw_arguments) {
                    Ok(parsed @ Value::Object(_)) => {
                        let canonical = py_json_dumps_ascii(&parsed);
                        (canonical, self.agent.call_tool(&name, &parsed).await)
                    }
                    _ => (
                        raw_arguments.clone(),
                        super::agents::ToolResult {
                            output: format!("Error parsing arguments for `{name}`: invalid JSON"),
                            is_error: true,
                        },
                    ),
                };
                tool_items.push(ChatItem::FunctionCall { group: group.clone(), call_id: call_id.clone(), name: name.clone(), arguments });
                tool_items.push(ChatItem::FunctionCallOutput { call_id, name, output: result.output, is_error: result.is_error });
            }
            if tool_items.is_empty() {
                break;
            }
            let max_steps_reached = step > MAX_TOOL_STEPS;
            step += 1;
            committed.extend(tool_items.iter().cloned());
            context.items.extend(tool_items);
            tool_choice = Some(if max_steps_reached { "none" } else { "auto" });
        }

        self.set_last_reply(replies.last().map_or("", String::as_str));
        if speaker.finish().await? {
            sink.finish_audio().await?;
            sink.wait_played().await?;
        }
        self.history.items.extend(committed);
        for reply in replies {
            sink.transcript("ai", &reply).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_complete_only_when_more_text_follows() {
        let mut pending = "はい。失礼".to_string();
        assert_eq!(take_complete_sentence(&mut pending), Some("はい。".into()));
        assert_eq!(pending, "失礼");
        let mut pending = "本当ですか！？".to_string();
        assert_eq!(take_complete_sentence(&mut pending), None, "the run may continue");
        pending.push_str("」次");
        assert_eq!(take_complete_sentence(&mut pending), Some("本当ですか！？」".into()));
    }

    #[test]
    fn split_matches_speech_tts() {
        assert_eq!(
            split_sentences("回覧板はポストに入れてください。入らない場合はお知らせください。"),
            vec!["回覧板はポストに入れてください。".to_string(), "入らない場合はお知らせください。".to_string()]
        );
        assert_eq!(split_sentences("  "), Vec::<String>::new());
        assert_eq!(split_sentences("終わりなし"), vec!["終わりなし".to_string()]);
    }
}
