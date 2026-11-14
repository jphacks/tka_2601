//! The relay's [`VoiceRuntime`] backed by [`Session`] (port of `relay/agent.py` `DeviceAgent`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use super::agents::{Agent, ChatModel, DoorAgent, ReceptionAgent};
use super::clients::warmup::{CallWarmup, CALL_WARMUP_FRESH};
use super::session::{Recognizer, Session, SpeechBackend};
use crate::config::Settings;
use crate::persistence::device_api::DeviceApi;
use crate::reception::desk::{DeviceReservations, ReceptionDesk, ReservationSource};
use crate::relay::{OutputSink, RuntimeConfig, RuntimeFactory, VoiceRuntime};

/// What every call shares: settings and the model clients.
pub struct Models {
    pub settings: Arc<Settings>,
    pub device_api: DeviceApi,
    pub chat: Arc<dyn ChatModel>,
    pub speech: Arc<dyn SpeechBackend>,
    pub recognizer: Arc<dyn Recognizer>,
    /// Wakes the on-demand models at the start of each call.
    pub call_warmup: Arc<CallWarmup>,
}

pub struct DeviceRuntimeFactory {
    pub models: Arc<Models>,
}

impl RuntimeFactory for DeviceRuntimeFactory {
    fn create(&self, config: RuntimeConfig, sink: Arc<dyn OutputSink>) -> Arc<dyn VoiceRuntime> {
        Arc::new(DeviceRuntime::new(self.models.clone(), config, sink))
    }
}

pub struct DeviceRuntime {
    models: Arc<Models>,
    sink: Arc<dyn OutputSink>,
    session: Mutex<Session>,
    ends_call: Arc<AtomicBool>,
    desk: Option<Arc<ReceptionDesk>>,
    prefetch: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl DeviceRuntime {
    pub fn new(models: Arc<Models>, config: RuntimeConfig, sink: Arc<dyn OutputSink>) -> Self {
        let settings = &models.settings;
        let (agent, desk): (Box<dyn Agent>, Option<Arc<ReceptionDesk>>) = match (config.device_key, config.shop) {
            (Some(device_key), Some(shop)) => {
                let source: Arc<dyn ReservationSource> =
                    Arc::new(DeviceReservations { api: models.device_api.clone(), device_key });
                let desk = Arc::new(ReceptionDesk::new(
                    Some(source),
                    Duration::from_secs_f64(settings.calendar_cache_seconds),
                ));
                (Box::new(ReceptionAgent::new(desk.clone(), Some(shop))), Some(desk))
            }
            _ => (
                Box::new(DoorAgent::new(&config.house_rules, settings.max_house_rules_chars, &settings.house_rules)),
                None,
            ),
        };
        let session = Session::new(agent);
        let ends_call = session.ends_call.clone();
        Self { models, sink, session: Mutex::new(session), ends_call, desk, prefetch: std::sync::Mutex::new(None) }
    }
}

#[async_trait::async_trait]
impl VoiceRuntime for DeviceRuntime {
    async fn start(&self) -> anyhow::Result<()> {
        // The greeting is cached, so a stopped ASR/LLM/TTS would otherwise first boot when
        // the visitor's words arrive. Boot them now, in the background.
        self.models.call_warmup.wake(self.models.settings.clone(), CALL_WARMUP_FRESH);
        if let Some(desk) = self.desk.clone() {
            // Read today's reservations while the greeting plays.
            let handle = tokio::spawn(async move { desk.prefetch().await });
            *self.prefetch.lock().expect("prefetch lock") = Some(handle);
        }
        Ok(())
    }

    async fn recognize(&self, pcm: Vec<u8>) -> anyhow::Result<String> {
        // A failed recognition (after the client's own retry) is treated as nothing heard:
        // the relay answers no_reply and the device listens again instead of hanging up.
        let text = match self.models.recognizer.recognize(pcm).await {
            Ok(text) => text.trim().to_string(),
            Err(error) => {
                tracing::warn!("speech recognition failed; treating the turn as unheard: {error:#}");
                String::new()
            }
        };
        if !text.is_empty() {
            self.sink.transcript("visitor", &text).await?;
        }
        Ok(text)
    }

    async fn reply(&self, text: Option<String>) -> anyhow::Result<()> {
        let mut session = self.session.lock().await;
        let speech = self.models.speech.as_ref();
        match text {
            None => session.greet(speech, self.sink.as_ref()).await,
            Some(text) => session.reply(&text, self.models.chat.as_ref(), speech, self.sink.as_ref()).await,
        }
    }

    fn end_after_reply(&self) -> bool {
        self.ends_call.load(Ordering::SeqCst)
    }

    fn staff_requested(&self) -> bool {
        self.desk.as_ref().is_some_and(|desk| !desk.staff_requests().is_empty())
    }

    async fn close(&self) {
        let handle = self.prefetch.lock().expect("prefetch lock").take();
        if let Some(handle) = handle {
            handle.abort();
        }
    }
}
