//! Clients for the external models (ASR, LLM, TTS) and the text/audio helpers around them.
//!
//! Ports of `voice/speech_tts.py`, `core/warmup.py`, the `openai.STT`/`openai.LLM` clients
//! built in `voice/agent.py` and the livekit-agents 1.8.8 pieces those rely on
//! (`filter_markdown`, `filter_emoji`, `_parse_choice`, `rtc.AudioResampler`).

pub mod error;
pub mod llm;
pub mod resample;
pub mod stt;
pub mod text;
pub mod tts;
pub mod warmup;

pub use error::ClientError;
