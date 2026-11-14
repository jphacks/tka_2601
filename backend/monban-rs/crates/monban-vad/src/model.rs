//! Silero VAD inference (port of `livekit/plugins/silero/onnx_model.py`, 16 kHz only).

use std::sync::{Arc, Mutex, OnceLock};

use ort::environment::Environment;
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use ort::session::Session;
use ort::value::TensorRef;

use crate::VadError;

/// The bundled model (see `model/SOURCE` and `model/LICENSE-silero-vad`).
pub(crate) static MODEL_BYTES: &[u8] = include_bytes!("../model/silero_vad.onnx");

/// Inference rate. 8 kHz (256-sample windows) is not ported: Monban audio is 16 kHz.
pub const SAMPLE_RATE: u32 = 16_000;
/// Samples per inference window at 16 kHz.
pub const WINDOW_SAMPLES: usize = 512;
/// Samples of the previous window prepended to each input (v5 model).
pub(crate) const CONTEXT_SAMPLES: usize = 64;
const STATE_LEN: usize = 2 * 128;
const SR: [i64; 1] = [SAMPLE_RATE as i64];

/// One ONNX Runtime session, shared by every stream of a [`crate::Vad`].
///
/// ort's `Session::run` takes `&mut self`, so streams take turns through a mutex; one inference
/// is ~0.1 ms. The recurrent state lives in each stream's [`ModelState`], not in the session.
#[derive(Clone)]
pub(crate) struct SharedSession(Arc<Mutex<Session>>);

/// ONNX Runtime allows one environment per process and ort refuses a second `init().build()`
/// even after the first is dropped, so it is created once and kept for the process lifetime.
fn environment() -> Result<&'static Environment, VadError> {
    static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        ort::init()
            .with_name("monban-vad")
            .build()
            .map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(|e| VadError::Load(e.clone()))
}

impl SharedSession {
    pub(crate) fn load(model: &[u8]) -> Result<Self, VadError> {
        // Same session options as livekit's new_inference_session: full graph optimization
        // (onnxruntime's default), one thread each, no spinning, sequential execution, CPU.
        let load = |e: ort::Error<SessionBuilder>| VadError::Load(e.to_string());
        let session = Session::builder(environment()?)
            .map_err(|e| VadError::Load(e.to_string()))?
            .with_optimization_level(GraphOptimizationLevel::All)
            .map_err(load)?
            .with_intra_threads(1)
            .map_err(load)?
            .with_inter_threads(1)
            .map_err(load)?
            .with_parallel_execution(false)
            .map_err(load)?
            .with_intra_op_spinning(false)
            .map_err(load)?
            .with_inter_op_spinning(false)
            .map_err(load)?
            .commit_from_memory(model)
            .map_err(|e| VadError::Load(e.to_string()))?;
        Ok(Self(Arc::new(Mutex::new(session))))
    }
}

/// Per-stream model state: the RNN state and the 64-sample context (`OnnxModel` in Python).
pub(crate) struct ModelState {
    session: SharedSession,
    input: [f32; CONTEXT_SAMPLES + WINDOW_SAMPLES],
    state: [f32; STATE_LEN],
}

impl ModelState {
    pub(crate) fn new(session: SharedSession) -> Self {
        Self {
            session,
            input: [0.0; CONTEXT_SAMPLES + WINDOW_SAMPLES],
            state: [0.0; STATE_LEN],
        }
    }

    pub(crate) fn reset(&mut self) {
        self.input.fill(0.0);
        self.state.fill(0.0);
    }

    /// Runs one window and returns the raw speech probability.
    ///
    /// `input[..64]` already holds the context (the last 64 samples of the previous window, zeros
    /// after a reset), exactly like `OnnxModel.__call__`.
    pub(crate) fn infer(&mut self, window: &[f32; WINDOW_SAMPLES]) -> Result<f32, VadError> {
        self.input[CONTEXT_SAMPLES..].copy_from_slice(window);
        let inference = |e: ort::Error| VadError::Inference(e.to_string());
        let (probability, state) = {
            let mut session = self
                .session
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let input = TensorRef::from_array_view((
                [1usize, CONTEXT_SAMPLES + WINDOW_SAMPLES],
                &self.input[..],
            ))
            .map_err(inference)?;
            let state = TensorRef::from_array_view(([2usize, 1, 128], &self.state[..]))
                .map_err(inference)?;
            let sr = TensorRef::from_array_view(((), &SR[..])).map_err(inference)?;
            let outputs = session
                .run(ort::inputs!["input" => input, "state" => state, "sr" => sr])
                .map_err(inference)?;
            let (_, output) = outputs["output"]
                .try_extract_tensor::<f32>()
                .map_err(inference)?;
            let (_, state_n) = outputs["stateN"]
                .try_extract_tensor::<f32>()
                .map_err(inference)?;
            let probability = *output
                .first()
                .ok_or_else(|| VadError::Inference("empty output tensor".into()))?;
            if state_n.len() != STATE_LEN {
                return Err(VadError::Inference(format!(
                    "stateN has {} values, expected {STATE_LEN}",
                    state_n.len()
                )));
            }
            let mut state = [0.0; STATE_LEN];
            state.copy_from_slice(state_n);
            (probability, state)
        };
        self.state = state;
        self.input.copy_within(WINDOW_SAMPLES.., 0);
        Ok(probability)
    }
}
