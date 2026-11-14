//! Silero VAD for Monban, ported from livekit-plugins-silero 1.8.8 (`silero.VAD` /
//! `VADStream._main_task`) so the Rust server decides where speech starts and ends the same way
//! the Python voice agent did.
//!
//! Input is 16 kHz mono s16le in chunks of any length. Every 512 samples (32 ms) the model runs
//! once and the stream emits an [`VadEventKind::InferenceDone`] event, followed by
//! [`VadEventKind::StartOfSpeech`] / [`VadEventKind::EndOfSpeech`] when the speech state changes.
//! The API is synchronous; callers on an async runtime decide whether to use `spawn_blocking`.
//!
//! ```no_run
//! use monban_vad::{Vad, VadEventKind, VadOptions};
//!
//! let vad = Vad::new(VadOptions::monban())?;
//! let mut stream = vad.stream();
//! for event in stream.push(&[0i16; 320])? {
//!     if event.kind == VadEventKind::EndOfSpeech {
//!         let _utterance: &[i16] = &event.frames; // prefix padding included
//!     }
//! }
//! # Ok::<(), monban_vad::VadError>(())
//! ```
//!
//! # Building
//!
//! Inference runs on ONNX Runtime 1.31 through the `ort` crate.
//!
//! - macOS: `ort` downloads its prebuilt static library at build time (cdn.pyke.io, cached in
//!   `~/Library/Caches/ort.pyke.io`). `build.rs` links clang's runtime for LTO release builds.
//! - Linux (Debian bookworm, arm64): ort's prebuilt static library needs a newer libstdc++ than
//!   bookworm's GCC 12 and fails to link. Link Microsoft's official shared library instead:
//!   download `onnxruntime-linux-aarch64-1.31.0.tgz` from the GitHub release, build with
//!   `ORT_LIB_LOCATION=<dir>/lib ORT_PREFER_DYNAMIC_LINK=1`, and ship `libonnxruntime.so.1`
//!   (found through `LD_LIBRARY_PATH` or `ldconfig`). The runtime image needs nothing else
//!   (`libstdc++6` is part of `debian:bookworm-slim`).

mod model;
mod stream;

pub use model::{SAMPLE_RATE, WINDOW_SAMPLES};
pub use stream::{VadEvent, VadEventKind, VadStream};

/// Errors from loading the model or running it.
#[derive(Debug, thiserror::Error)]
pub enum VadError {
    #[error("invalid VAD options: {0}")]
    InvalidOptions(String),
    #[error("failed to load the Silero VAD model: {0}")]
    Load(String),
    #[error("Silero VAD inference failed: {0}")]
    Inference(String),
}

/// Options of `silero.VAD.load` (durations in seconds).
#[derive(Debug, Clone, PartialEq)]
pub struct VadOptions {
    /// Speech must last this long before START_OF_SPEECH.
    pub min_speech_duration: f64,
    /// Silence must last this long before END_OF_SPEECH.
    pub min_silence_duration: f64,
    /// Audio kept before the detected speech and included in the event frames.
    pub prefix_padding_duration: f64,
    /// Longest speech kept in the buffer (prefix padding is added on top).
    pub max_buffered_speech: f64,
    /// Smoothed probability at or above this counts as speech.
    pub activation_threshold: f64,
    /// While speaking, probability above this still counts as speech. `None` means
    /// `max(activation_threshold - 0.15, 0.01)`, livekit's default.
    pub deactivation_threshold: Option<f64>,
}

impl Default for VadOptions {
    /// livekit's defaults (`silero.VAD.load()` without arguments).
    fn default() -> Self {
        Self {
            min_speech_duration: 0.05,
            min_silence_duration: 0.55,
            prefix_padding_duration: 0.5,
            max_buffered_speech: 60.0,
            activation_threshold: 0.5,
            deactivation_threshold: None,
        }
    }
}

impl VadOptions {
    /// The settings of the Python voice agent (`monban_backend/voice/agent.py`).
    pub fn monban() -> Self {
        Self {
            min_speech_duration: 0.35,
            min_silence_duration: 0.5,
            prefix_padding_duration: 0.4,
            activation_threshold: 0.6,
            ..Self::default()
        }
    }

    pub(crate) fn effective_deactivation_threshold(&self) -> f64 {
        // Python: `deactivation_threshold or max(activation_threshold - 0.15, 0.01)`.
        self.deactivation_threshold
            .unwrap_or_else(|| (self.activation_threshold - 0.15).max(0.01))
    }

    fn validate(&self) -> Result<(), VadError> {
        let durations = [
            ("min_speech_duration", self.min_speech_duration),
            ("min_silence_duration", self.min_silence_duration),
            ("prefix_padding_duration", self.prefix_padding_duration),
            ("max_buffered_speech", self.max_buffered_speech),
        ];
        for (name, value) in durations {
            if !value.is_finite() || value < 0.0 {
                return Err(VadError::InvalidOptions(format!(
                    "{name} must be a finite value >= 0, got {value}"
                )));
            }
        }
        if !self.activation_threshold.is_finite() {
            return Err(VadError::InvalidOptions(
                "activation_threshold must be finite".into(),
            ));
        }
        if let Some(threshold) = self.deactivation_threshold {
            // Same check as silero.VAD.load.
            if !threshold.is_finite() || threshold <= 0.0 {
                return Err(VadError::InvalidOptions(
                    "deactivation_threshold must be greater than 0".into(),
                ));
            }
        }
        Ok(())
    }
}

/// A loaded model plus options. Cheap to share; each [`VadStream`] keeps its own model state.
#[derive(Clone)]
pub struct Vad {
    options: VadOptions,
    session: model::SharedSession,
}

impl Vad {
    /// Loads the bundled Silero model (blocking, tens of milliseconds).
    pub fn new(options: VadOptions) -> Result<Self, VadError> {
        options.validate()?;
        let session = model::SharedSession::load(model::MODEL_BYTES)?;
        Ok(Self { options, session })
    }

    pub fn options(&self) -> &VadOptions {
        &self.options
    }

    /// A new stream with fresh model state.
    pub fn stream(&self) -> VadStream {
        VadStream::new(
            self.options.clone(),
            model::ModelState::new(self.session.clone()),
        )
    }
}

impl std::fmt::Debug for Vad {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vad")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deactivation_threshold_defaults_like_livekit() {
        assert_eq!(
            VadOptions::monban().effective_deactivation_threshold(),
            0.6 - 0.15
        );
        let low = VadOptions {
            activation_threshold: 0.1,
            ..VadOptions::default()
        };
        assert_eq!(low.effective_deactivation_threshold(), 0.01);
        let explicit = VadOptions {
            deactivation_threshold: Some(0.3),
            ..VadOptions::monban()
        };
        assert_eq!(explicit.effective_deactivation_threshold(), 0.3);
    }

    #[test]
    fn rejects_invalid_options() {
        let zero = VadOptions {
            deactivation_threshold: Some(0.0),
            ..VadOptions::monban()
        };
        assert!(matches!(Vad::new(zero), Err(VadError::InvalidOptions(_))));
        let negative = VadOptions {
            min_silence_duration: -1.0,
            ..VadOptions::monban()
        };
        assert!(matches!(
            Vad::new(negative),
            Err(VadError::InvalidOptions(_))
        ));
        let nan = VadOptions {
            max_buffered_speech: f64::NAN,
            ..VadOptions::monban()
        };
        assert!(matches!(Vad::new(nan), Err(VadError::InvalidOptions(_))));
    }

    #[test]
    fn runs_once_per_full_window_and_flush_drops_the_partial_one() {
        let vad = Vad::new(VadOptions::monban()).unwrap();
        let mut stream = vad.stream();
        assert!(stream.push(&[0; WINDOW_SAMPLES - 1]).unwrap().is_empty());
        let events = stream.push(&[0; 2]).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, VadEventKind::InferenceDone);
        assert_eq!(events[0].samples_index, WINDOW_SAMPLES as u64);
        assert_eq!(events[0].frames.len(), WINDOW_SAMPLES);
        assert!(!events[0].speaking);

        // One sample is queued; flush drops it and restarts the counter.
        stream.flush();
        assert!(stream.push(&[0; WINDOW_SAMPLES - 1]).unwrap().is_empty());
        let events = stream.push(&[0; 1]).unwrap();
        assert_eq!(events[0].samples_index, WINDOW_SAMPLES as u64);
        // After a reset the first probability is unsmoothed, like the first window of a stream.
        let fresh = vad.stream().push(&[0; WINDOW_SAMPLES]).unwrap();
        assert_eq!(events[0].raw_probability, fresh[0].raw_probability);
        assert_eq!(events[0].probability, fresh[0].probability);
    }
}
