//! What a call does when an upstream fails (model, ASR) or the device output fails.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::stream::{self, StreamExt};
use serde_json::Value;

use super::agents::{ChatModel, DoorAgent, NodeEvent, NodeStream, ReceptionAgent};
use super::runtime::{DeviceRuntime, Models};
use super::session::{Recognizer, Resampler, Session, SpeechBackend, TextFilter};
use crate::config::tests::test_settings;
use crate::persistence::device_api::{DeviceApi, ShopProfile};
use crate::reception::desk::ReceptionDesk;
use crate::relay::{OutputSink, RuntimeConfig, VoiceRuntime};

#[derive(Clone, Copy)]
enum ModelBehavior {
    FailsAtOnce,
    FailsMidStream,
    Answers,
}

struct Model(ModelBehavior);

#[async_trait::async_trait]
impl ChatModel for Model {
    async fn stream(&self, _: Vec<Value>, _: Vec<Value>, _: Option<&'static str>) -> anyhow::Result<NodeStream> {
        match self.0 {
            ModelBehavior::FailsAtOnce => anyhow::bail!("LLM is unreachable"),
            ModelBehavior::FailsMidStream => Ok(stream::iter(vec![
                Ok(NodeEvent::Text("承知しました。".into())),
                Ok(NodeEvent::ToolCall { call_id: "c1".into(), name: "request_staff".into(), arguments: "{}".into() }),
                Err(anyhow::anyhow!("stream cut")),
            ])
            .boxed()),
            ModelBehavior::Answers => Ok(stream::iter(vec![Ok(NodeEvent::Text("恐れ入りますが、改めてご連絡いただけますか。".into()))]).boxed()),
        }
    }
}

struct Plain;
impl TextFilter for Plain {
    fn push(&mut self, chunk: &str) -> String {
        chunk.to_string()
    }
    fn finish(&mut self) -> String {
        String::new()
    }
}
struct Same;
impl Resampler for Same {
    fn process(&mut self, pcm: &[u8]) -> Vec<u8> {
        pcm.to_vec()
    }
    fn flush(&mut self) -> Vec<u8> {
        Vec::new()
    }
}

/// 10 ms of PCM per character; `fail` makes every synthesis fail.
struct Speech {
    fail: bool,
}
#[async_trait::async_trait]
impl SpeechBackend for Speech {
    fn text_filter(&self) -> Box<dyn TextFilter> {
        Box::new(Plain)
    }
    fn resampler(&self) -> Box<dyn Resampler> {
        Box::new(Same)
    }
    async fn synthesize(&self, sentence: &str) -> anyhow::Result<Vec<u8>> {
        anyhow::ensure!(!self.fail, "TTS is unreachable");
        Ok(vec![1; sentence.chars().count() * 320])
    }
}

#[derive(Default)]
struct Sink {
    audio_bytes: Mutex<usize>,
    transcripts: Mutex<Vec<(String, String)>>,
    finished: Mutex<u32>,
}
#[async_trait::async_trait]
impl OutputSink for Sink {
    async fn write_audio(&self, pcm: Vec<u8>) -> anyhow::Result<()> {
        *self.audio_bytes.lock().unwrap() += pcm.len();
        Ok(())
    }
    async fn finish_audio(&self) -> anyhow::Result<()> {
        *self.finished.lock().unwrap() += 1;
        Ok(())
    }
    async fn wait_played(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn transcript(&self, speaker: &str, text: &str) -> anyhow::Result<()> {
        self.transcripts.lock().unwrap().push((speaker.into(), text.into()));
        Ok(())
    }
}

fn door() -> Session {
    let settings = test_settings();
    Session::new(Box::new(DoorAgent::new("", settings.max_house_rules_chars, &settings.house_rules)))
}

fn ai_replies(sink: &Sink) -> Vec<String> {
    sink.transcripts.lock().unwrap().iter().filter(|(who, _)| who == "ai").map(|(_, text)| text.clone()).collect()
}

#[tokio::test]
async fn door_model_failure_speaks_the_visit_fallback() {
    let mut session = door();
    let sink = Sink::default();
    let speech = Speech { fail: false };
    session.greet(&speech, &sink).await.unwrap();
    // A gas inspection reaches the model; the model is down.
    session.reply("ガスの点検に来ました。", &Model(ModelBehavior::FailsAtOnce), &speech, &sink).await.unwrap();
    let replies = ai_replies(&sink);
    assert_eq!(replies.len(), 2);
    assert!(!replies[1].is_empty());
    assert_eq!(*sink.finished.lock().unwrap(), 2, "the fallback was spoken and finished");
    // The same turn with a working model gets the model's answer.
    let mut working = door();
    let sink = Sink::default();
    working.greet(&speech, &sink).await.unwrap();
    working.reply("ガスの点検に来ました。", &Model(ModelBehavior::Answers), &speech, &sink).await.unwrap();
    assert_eq!(ai_replies(&sink)[1], "恐れ入りますが、改めてご連絡いただけますか。");
}

#[tokio::test]
async fn reception_model_failure_hands_the_visitor_to_staff() {
    let desk = Arc::new(ReceptionDesk::new(None, Duration::from_secs(30)));
    let shop = ShopProfile { name: "店".into(), ..Default::default() };
    let mut session = Session::new(Box::new(ReceptionAgent::new(desk.clone(), Some(shop))));
    let sink = Sink::default();
    let speech = Speech { fail: false };
    session.greet(&speech, &sink).await.unwrap();
    session.reply("トイレを借りてもいいですか。", &Model(ModelBehavior::FailsAtOnce), &speech, &sink).await.unwrap();
    let replies = ai_replies(&sink);
    assert!(replies[1].contains("スタッフに確認を依頼しました"), "{replies:?}");
    assert_eq!(desk.staff_requests().len(), 1);
}

#[tokio::test]
async fn a_stream_cut_after_speech_keeps_what_was_said_and_runs_no_tools() {
    let desk = Arc::new(ReceptionDesk::new(None, Duration::from_secs(30)));
    let mut session = Session::new(Box::new(ReceptionAgent::new(desk.clone(), None)));
    let sink = Sink::default();
    let speech = Speech { fail: false };
    session.reply("トイレを借りてもいいですか。", &Model(ModelBehavior::FailsMidStream), &speech, &sink).await.unwrap();
    assert_eq!(ai_replies(&sink), vec!["承知しました。".to_string()]);
    assert!(desk.staff_requests().is_empty(), "the half-received tool call was not run");
}

#[tokio::test]
async fn speech_output_failures_still_end_the_reply_with_an_error() {
    let mut session = door();
    let sink = Sink::default();
    let error = session.greet(&Speech { fail: true }, &sink).await.unwrap_err();
    assert!(format!("{error:#}").contains("TTS is unreachable"));
    assert!(ai_replies(&sink).is_empty());
}

struct FailingAsr;
#[async_trait::async_trait]
impl Recognizer for FailingAsr {
    async fn recognize(&self, _pcm: Vec<u8>) -> anyhow::Result<String> {
        anyhow::bail!("ASR timed out")
    }
}

#[tokio::test]
async fn failed_recognition_is_an_unheard_turn() {
    let settings = Arc::new(test_settings());
    let models = Arc::new(Models {
        device_api: DeviceApi::new(reqwest::Client::new(), &settings),
        chat: Arc::new(Model(ModelBehavior::Answers)),
        speech: Arc::new(Speech { fail: false }),
        recognizer: Arc::new(FailingAsr),
        settings,
    });
    let sink = Arc::new(Sink::default());
    let config = RuntimeConfig { house_rules: String::new(), device_key: None, shop: None };
    let runtime = DeviceRuntime::new(models, config, sink.clone());
    assert_eq!(runtime.recognize(vec![0; 640]).await.unwrap(), "");
    assert!(sink.transcripts.lock().unwrap().is_empty());
}
