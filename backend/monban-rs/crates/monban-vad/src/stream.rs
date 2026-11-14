//! Streaming speech/silence decisions: a port of `livekit.plugins.silero.VADStream._main_task`
//! for 16 kHz input (no resampling, so the input and inference frames are the same samples).

use std::time::{Duration, Instant};

use crate::model::{ModelState, SAMPLE_RATE, WINDOW_SAMPLES};
use crate::{VadError, VadOptions};

/// Weight of the previous value in livekit's `ExpFilter(alpha=0.35)` over the probabilities.
const EXP_FILTER_ALPHA: f64 = 0.35;
/// Python logs "VAD inference is slower than realtime" past this (`SLOW_INFERENCE_THRESHOLD`).
const SLOW_INFERENCE: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadEventKind {
    /// `VADEventType.START_OF_SPEECH`.
    StartOfSpeech,
    /// `VADEventType.INFERENCE_DONE`, once per 512-sample window.
    InferenceDone,
    /// `VADEventType.END_OF_SPEECH`.
    EndOfSpeech,
}

/// `livekit.agents.vad.VADEvent`. Times count from the stream start or the last [`VadStream::flush`].
#[derive(Debug, Clone, PartialEq)]
pub struct VadEvent {
    pub kind: VadEventKind,
    /// Samples run through the model so far (a multiple of 512); the event happened at the end of
    /// that window.
    pub samples_index: u64,
    /// `samples_index` in seconds, accumulated window by window as livekit does.
    pub timestamp: f64,
    pub speech_duration: f64,
    pub silence_duration: f64,
    /// Smoothed speech probability (InferenceDone only, 0 otherwise).
    pub probability: f64,
    /// Raw model output before smoothing (InferenceDone only, 0 otherwise). Not in livekit's event.
    pub raw_probability: f32,
    /// Time spent on the window (InferenceDone only).
    pub inference_duration: Duration,
    pub speaking: bool,
    /// Silence counted toward `min_silence_duration` (InferenceDone only).
    pub raw_accumulated_silence: f64,
    /// Speech counted toward `min_speech_duration` (InferenceDone only).
    pub raw_accumulated_speech: f64,
    /// 16 kHz mono samples. StartOfSpeech: the speech buffer so far (prefix padding included);
    /// EndOfSpeech: the whole utterance (prefix padding included, capped by
    /// `max_buffered_speech`); InferenceDone: the 512 samples of the window.
    pub frames: Vec<i16>,
}

/// One audio stream. Not shared between threads; create one per connection with [`crate::Vad::stream`].
pub struct VadStream {
    options: VadOptions,
    deactivation_threshold: f64,
    model: ModelState,
    filtered: Option<f64>,

    /// Samples pushed but not yet run (always fewer than 512 between calls).
    pending: Vec<i16>,

    speech_buffer: Vec<i16>,
    speech_buffer_index: usize,
    speech_buffer_max_reached: bool,
    prefix_padding_samples: usize,

    pub_speaking: bool,
    pub_speech_duration: f64,
    pub_silence_duration: f64,
    pub_current_sample: u64,
    pub_timestamp: f64,
    speech_threshold_duration: f64,
    silence_threshold_duration: f64,
}

impl VadStream {
    pub(crate) fn new(options: VadOptions, model: ModelState) -> Self {
        let rate = f64::from(SAMPLE_RATE);
        // int(prefix_padding_duration * rate), int(max_buffered_speech * rate) + prefix
        let prefix_padding_samples = (options.prefix_padding_duration * rate) as usize;
        let buffer_len = (options.max_buffered_speech * rate) as usize + prefix_padding_samples;
        Self {
            deactivation_threshold: options.effective_deactivation_threshold(),
            options,
            model,
            filtered: None,
            pending: Vec::with_capacity(WINDOW_SAMPLES * 4),
            speech_buffer: vec![0; buffer_len],
            speech_buffer_index: 0,
            speech_buffer_max_reached: false,
            prefix_padding_samples,
            pub_speaking: false,
            pub_speech_duration: 0.0,
            pub_silence_duration: 0.0,
            pub_current_sample: 0,
            pub_timestamp: 0.0,
            speech_threshold_duration: 0.0,
            silence_threshold_duration: 0.0,
        }
    }

    /// Whether the stream is inside a speech segment (between StartOfSpeech and EndOfSpeech).
    pub fn speaking(&self) -> bool {
        self.pub_speaking
    }

    /// Feeds 16 kHz mono samples and returns the events of every complete 512-sample window.
    pub fn push(&mut self, samples: &[i16]) -> Result<Vec<VadEvent>, VadError> {
        let mut events = Vec::new();
        self.push_into(samples, &mut events)?;
        Ok(events)
    }

    /// Like [`Self::push`], appending to `events`. On an inference error the events of the
    /// windows before it are already in `events` and the failed window stays queued, so the next
    /// push retries it.
    pub fn push_into(
        &mut self,
        samples: &[i16],
        events: &mut Vec<VadEvent>,
    ) -> Result<(), VadError> {
        self.pending.extend_from_slice(samples);
        let mut consumed = 0;
        let mut result = Ok(());
        while self.pending.len() - consumed >= WINDOW_SAMPLES {
            let mut window = [0i16; WINDOW_SAMPLES];
            window.copy_from_slice(&self.pending[consumed..consumed + WINDOW_SAMPLES]);
            if let Err(error) = self.process_window(&window, events) {
                result = Err(error);
                break;
            }
            consumed += WINDOW_SAMPLES;
        }
        self.pending.drain(..consumed);
        result
    }

    /// livekit's `flush()`: a hard segment boundary. Drops the partial window and every
    /// accumulated speech/silence state (model state and smoothing included) and restarts the
    /// sample counter at 0. No EndOfSpeech is emitted, even mid-speech.
    pub fn flush(&mut self) {
        self.model.reset();
        self.filtered = None;
        self.pending.clear();
        self.speech_buffer_index = 0;
        self.speech_buffer_max_reached = false;
        self.pub_speaking = false;
        self.pub_speech_duration = 0.0;
        self.pub_silence_duration = 0.0;
        self.pub_current_sample = 0;
        self.pub_timestamp = 0.0;
        self.speech_threshold_duration = 0.0;
        self.silence_threshold_duration = 0.0;
    }

    fn process_window(
        &mut self,
        window: &[i16; WINDOW_SAMPLES],
        events: &mut Vec<VadEvent>,
    ) -> Result<(), VadError> {
        let start_time = Instant::now();

        // np.divide(int16, np.iinfo(np.int16).max, dtype=np.float32)
        let mut inference_f32 = [0f32; WINDOW_SAMPLES];
        for (out, &sample) in inference_f32.iter_mut().zip(window) {
            *out = f32::from(sample) / f32::from(i16::MAX);
        }
        let raw = self.model.infer(&inference_f32)?;
        let p = self.apply_exp_filter(f64::from(raw));

        let window_duration = WINDOW_SAMPLES as f64 / f64::from(SAMPLE_RATE);
        self.pub_current_sample += WINDOW_SAMPLES as u64;
        self.pub_timestamp += window_duration;

        // Copy the window into the speech buffer (input rate == inference rate: 512 samples).
        let available_space = self.speech_buffer.len() - self.speech_buffer_index;
        let to_copy = WINDOW_SAMPLES.min(available_space);
        if to_copy > 0 {
            self.speech_buffer[self.speech_buffer_index..self.speech_buffer_index + to_copy]
                .copy_from_slice(&window[..to_copy]);
            self.speech_buffer_index += to_copy;
        } else if !self.speech_buffer_max_reached {
            self.speech_buffer_max_reached = true;
            tracing::warn!(
                "max_buffered_speech reached, ignoring further data for the current speech input"
            );
        }

        let inference_duration = start_time.elapsed();
        if inference_duration > SLOW_INFERENCE {
            tracing::warn!(?inference_duration, "VAD inference is slower than realtime");
        }

        if self.pub_speaking {
            self.pub_speech_duration += window_duration;
        } else {
            self.pub_silence_duration += window_duration;
        }

        events.push(VadEvent {
            kind: VadEventKind::InferenceDone,
            samples_index: self.pub_current_sample,
            timestamp: self.pub_timestamp,
            speech_duration: self.pub_speech_duration,
            silence_duration: self.pub_silence_duration,
            probability: p,
            raw_probability: raw,
            inference_duration,
            speaking: self.pub_speaking,
            raw_accumulated_silence: self.silence_threshold_duration,
            raw_accumulated_speech: self.speech_threshold_duration,
            frames: window.to_vec(),
        });

        if p >= self.options.activation_threshold
            || (self.pub_speaking && p > self.deactivation_threshold)
        {
            self.speech_threshold_duration += window_duration;
            self.silence_threshold_duration = 0.0;

            if !self.pub_speaking
                && self.speech_threshold_duration >= self.options.min_speech_duration
            {
                self.pub_speaking = true;
                self.pub_silence_duration = 0.0;
                self.pub_speech_duration = self.speech_threshold_duration;
                events.push(
                    self.transition_event(VadEventKind::StartOfSpeech, self.pub_speech_duration),
                );
            }
        } else {
            self.silence_threshold_duration += window_duration;
            self.speech_threshold_duration = 0.0;

            if !self.pub_speaking {
                self.reset_write_cursor();
            }

            if self.pub_speaking
                && self.silence_threshold_duration >= self.options.min_silence_duration
            {
                self.pub_speaking = false;
                self.pub_silence_duration = self.silence_threshold_duration;
                let speech_duration =
                    (self.pub_speech_duration - self.silence_threshold_duration).max(0.0);
                events.push(self.transition_event(VadEventKind::EndOfSpeech, speech_duration));
                self.pub_speech_duration = 0.0;
                self.reset_write_cursor();
            }
        }
        Ok(())
    }

    /// `ExpFilter.apply(exp=1.0, sample=p)`: the first sample is taken as is.
    fn apply_exp_filter(&mut self, sample: f64) -> f64 {
        let filtered = match self.filtered {
            None => sample,
            Some(previous) => EXP_FILTER_ALPHA * previous + (1.0 - EXP_FILTER_ALPHA) * sample,
        };
        self.filtered = Some(filtered);
        filtered
    }

    fn transition_event(&self, kind: VadEventKind, speech_duration: f64) -> VadEvent {
        VadEvent {
            kind,
            samples_index: self.pub_current_sample,
            timestamp: self.pub_timestamp,
            speech_duration,
            silence_duration: self.pub_silence_duration,
            probability: 0.0,
            raw_probability: 0.0,
            inference_duration: Duration::ZERO,
            speaking: kind == VadEventKind::StartOfSpeech,
            raw_accumulated_silence: 0.0,
            raw_accumulated_speech: 0.0,
            frames: self.speech_buffer[..self.speech_buffer_index].to_vec(),
        }
    }

    /// Keeps only the last `prefix_padding_samples` of the buffer, as the next speech's padding.
    fn reset_write_cursor(&mut self) {
        if self.speech_buffer_index <= self.prefix_padding_samples {
            return;
        }
        let start = self.speech_buffer_index - self.prefix_padding_samples;
        self.speech_buffer
            .copy_within(start..self.speech_buffer_index, 0);
        self.speech_buffer_max_reached = false;
        self.speech_buffer_index = self.prefix_padding_samples;
    }
}

impl std::fmt::Debug for VadStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VadStream")
            .field("speaking", &self.pub_speaking)
            .field("samples_index", &self.pub_current_sample)
            .field("pending", &self.pending.len())
            .finish_non_exhaustive()
    }
}
