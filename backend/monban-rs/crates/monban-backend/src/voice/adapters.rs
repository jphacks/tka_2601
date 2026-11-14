//! The model clients behind the session's traits.

use std::sync::Arc;

use futures::StreamExt;
use serde_json::Value;

use super::agents::{ChatModel, NodeEvent, NodeStream};
use super::clients::llm::{LlmClient, LlmEvent};
use super::clients::resample::StreamingResampler;
use super::clients::stt::SttClient;
use super::clients::text::TtsTextFilter;
use super::clients::tts::{livekit_marker_bytes, SpeechCppTts};
use super::session::{Recognizer, Resampler, SpeechBackend, TextFilter};
use crate::config::Settings;

const DEVICE_RATE: u32 = 16_000;

pub struct LlmChatModel(pub LlmClient);

#[async_trait::async_trait]
impl ChatModel for LlmChatModel {
    async fn stream(
        &self,
        messages: Vec<Value>,
        tools: Vec<Value>,
        tool_choice: Option<&'static str>,
    ) -> anyhow::Result<NodeStream> {
        let stream = self.0.stream(messages, tools, tool_choice).await?;
        Ok(stream
            .map(|event| {
                event.map(|event| match event {
                    LlmEvent::Text(text) => NodeEvent::Text(text),
                    LlmEvent::ToolCall { call_id, name, arguments } => NodeEvent::ToolCall { call_id, name, arguments },
                })
            })
            .boxed())
    }
}

pub struct SttRecognizer(pub SttClient);

#[async_trait::async_trait]
impl Recognizer for SttRecognizer {
    async fn recognize(&self, pcm: Vec<u8>) -> anyhow::Result<String> {
        Ok(self.0.transcribe(&pcm).await?)
    }
}

struct Filter(TtsTextFilter);

impl TextFilter for Filter {
    fn push(&mut self, chunk: &str) -> String {
        self.0.push(chunk).concat()
    }
    fn finish(&mut self) -> String {
        self.0.finish().unwrap_or_default()
    }
}

impl Resampler for StreamingResampler {
    fn process(&mut self, pcm: &[u8]) -> Vec<u8> {
        StreamingResampler::process(self, pcm)
    }
    fn flush(&mut self) -> Vec<u8> {
        self.finish()
    }
}

pub struct SpeechCppBackend {
    pub tts: SpeechCppTts,
}

#[async_trait::async_trait]
impl SpeechBackend for SpeechCppBackend {
    fn text_filter(&self) -> Box<dyn TextFilter> {
        Box::new(Filter(TtsTextFilter::new()))
    }
    fn resampler(&self) -> Box<dyn Resampler> {
        Box::new(StreamingResampler::new(self.tts.sample_rate(), DEVICE_RATE))
    }
    async fn synthesize(&self, sentence: &str) -> anyhow::Result<Vec<u8>> {
        Ok(self.tts.synthesize(sentence).await?)
    }
    async fn synthesize_to(&self, sentence: &str, tx: tokio::sync::mpsc::Sender<Vec<u8>>) -> anyhow::Result<()> {
        self.tts.synthesize_to(sentence, Some(&tx)).await?;
        Ok(())
    }
    fn segment_marker(&self) -> Vec<u8> {
        vec![0; livekit_marker_bytes(self.tts.sample_rate())]
    }
}

/// The real models for every call.
pub fn live_models(settings: Arc<Settings>, http: reqwest::Client) -> super::runtime::Models {
    let tts = SpeechCppTts::new(settings.clone());
    tts.schedule_greeting_prewarm();
    let llm = LlmClient::new(settings.clone());
    let stt = SttClient::new(settings.clone());
    let call_warmup = Arc::new(super::clients::warmup::CallWarmup::with_clients(
        super::clients::warmup::WarmClients { asr: stt.http(), llm: llm.http(), tts: tts.http() },
    ));
    super::runtime::Models {
        device_api: crate::persistence::device_api::DeviceApi::new(http, &settings),
        chat: Arc::new(LlmChatModel(llm)),
        speech: Arc::new(SpeechCppBackend { tts }),
        recognizer: Arc::new(SttRecognizer(stt)),
        call_warmup,
        settings,
    }
}
