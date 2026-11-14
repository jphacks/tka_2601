//! Compares the Rust VAD with livekit's Silero VAD on the fixtures written by
//! `tools/vad_oracle/capture.py` (events, times, speech audio and probabilities).

use std::path::{Path, PathBuf};

use monban_vad::{Vad, VadEvent, VadEventKind, VadOptions};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Allowed difference of probabilities (both sides run ONNX Runtime 1.31 on the same model, so
/// the observed difference is 0; the tolerance only guards against CPU-dependent kernels).
const PROBABILITY_TOLERANCE: f64 = 1e-4;
/// Durations and timestamps are summed window by window in f64 on both sides.
const TIME_TOLERANCE: f64 = 1e-9;

#[derive(Deserialize)]
struct Fixture {
    scenario: String,
    samples: usize,
    options: serde_json::Map<String, serde_json::Value>,
    runs: Vec<Run>,
}

#[derive(Deserialize)]
struct Run {
    chunk: usize,
    flush_after_samples: Option<usize>,
    raw_probabilities: Vec<f64>,
    events: Vec<OracleEvent>,
}

#[derive(Deserialize)]
struct OracleEvent {
    #[serde(rename = "type")]
    kind: String,
    samples_index: u64,
    timestamp: f64,
    speech_duration: f64,
    silence_duration: f64,
    speaking: bool,
    frames_len: usize,
    frames_sha256: String,
    probability: Option<f64>,
    raw_accumulated_speech: Option<f64>,
    raw_accumulated_silence: Option<f64>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixtures() -> Vec<Fixture> {
    let mut paths: Vec<_> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && path
                    .file_name()
                    .is_some_and(|name| name != "scenarios.json")
        })
        .collect();
    paths.sort();
    assert!(
        paths.len() >= 10,
        "expected the oracle fixtures, found {}",
        paths.len()
    );
    paths
        .iter()
        .map(|path| serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap())
        .collect()
}

/// 16 kHz mono s16le WAV (as written by Python's `wave`).
fn read_wav(path: &Path) -> Vec<i16> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let mut offset = 12;
    let mut format_ok = false;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let len = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body = &bytes[offset + 8..offset + 8 + len];
        if id == b"fmt " {
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let bits = u16::from_le_bytes([body[14], body[15]]);
            assert_eq!(
                (channels, rate, bits),
                (1, 16_000, 16),
                "{}",
                path.display()
            );
            format_ok = true;
        } else if id == b"data" {
            assert!(format_ok);
            return body
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
        }
        offset += 8 + len + (len & 1);
    }
    panic!("no data chunk in {}", path.display());
}

fn options_for(overrides: &serde_json::Map<String, serde_json::Value>) -> VadOptions {
    let mut options = VadOptions::monban();
    for (key, value) in overrides {
        let value = value.as_f64().unwrap();
        match key.as_str() {
            "min_speech_duration" => options.min_speech_duration = value,
            "min_silence_duration" => options.min_silence_duration = value,
            "prefix_padding_duration" => options.prefix_padding_duration = value,
            "max_buffered_speech" => options.max_buffered_speech = value,
            "activation_threshold" => options.activation_threshold = value,
            "deactivation_threshold" => options.deactivation_threshold = Some(value),
            other => panic!("unknown option {other}"),
        }
    }
    options
}

/// Pushes `audio` in `chunk`-sized pieces, flushing once `flush_after` samples were pushed
/// (as capture.py does), and returns every event.
fn run(vad: &Vad, audio: &[i16], chunk: usize, flush_after: Option<usize>) -> Vec<VadEvent> {
    let mut stream = vad.stream();
    let mut events = Vec::new();
    let mut pushed = 0;
    let mut flushed = false;
    for part in audio.chunks(chunk) {
        stream.push_into(part, &mut events).unwrap();
        pushed += part.len();
        if let Some(limit) = flush_after {
            if !flushed && pushed >= limit {
                stream.flush();
                flushed = true;
            }
        }
    }
    // capture.py ends with end_input(), which is a flush: no further events.
    stream.flush();
    events
}

fn kind_name(kind: VadEventKind) -> &'static str {
    match kind {
        VadEventKind::StartOfSpeech => "start_of_speech",
        VadEventKind::InferenceDone => "inference_done",
        VadEventKind::EndOfSpeech => "end_of_speech",
    }
}

fn sha256_hex(samples: &[i16]) -> String {
    let mut hasher = Sha256::new();
    for sample in samples {
        hasher.update(sample.to_le_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Default)]
struct Stats {
    events: usize,
    windows: usize,
    max_raw_diff: f64,
    max_filtered_diff: f64,
}

fn compare(label: &str, oracle: &Run, events: &[VadEvent], stats: &mut Stats) {
    assert_eq!(
        events.len(),
        oracle.events.len(),
        "{label}: event count; rust kinds = {:?}",
        events
            .iter()
            .filter(|e| e.kind != VadEventKind::InferenceDone)
            .map(|e| (e.kind, e.samples_index))
            .collect::<Vec<_>>()
    );
    let mut window = 0;
    for (index, (rust, py)) in events.iter().zip(&oracle.events).enumerate() {
        let at = format!(
            "{label} event #{index} ({} @ {})",
            py.kind, py.samples_index
        );
        assert_eq!(kind_name(rust.kind), py.kind, "{at}: kind");
        assert_eq!(rust.samples_index, py.samples_index, "{at}: samples_index");
        assert!(
            (rust.timestamp - py.timestamp).abs() <= TIME_TOLERANCE,
            "{at}: timestamp {} vs {}",
            rust.timestamp,
            py.timestamp
        );
        assert!(
            (rust.speech_duration - py.speech_duration).abs() <= TIME_TOLERANCE,
            "{at}: speech_duration {} vs {}",
            rust.speech_duration,
            py.speech_duration
        );
        assert!(
            (rust.silence_duration - py.silence_duration).abs() <= TIME_TOLERANCE,
            "{at}: silence_duration {} vs {}",
            rust.silence_duration,
            py.silence_duration
        );
        assert_eq!(rust.speaking, py.speaking, "{at}: speaking");
        assert_eq!(rust.frames.len(), py.frames_len, "{at}: frames length");
        assert_eq!(
            sha256_hex(&rust.frames),
            py.frames_sha256,
            "{at}: frames sha256"
        );
        if rust.kind == VadEventKind::InferenceDone {
            let filtered = py.probability.unwrap();
            let raw = oracle.raw_probabilities[window];
            let raw_diff = (f64::from(rust.raw_probability) - raw).abs();
            let filtered_diff = (rust.probability - filtered).abs();
            assert!(
                raw_diff <= PROBABILITY_TOLERANCE,
                "{at}: raw probability {} vs {raw}",
                rust.raw_probability
            );
            assert!(
                filtered_diff <= PROBABILITY_TOLERANCE,
                "{at}: probability {} vs {filtered}",
                rust.probability
            );
            stats.max_raw_diff = stats.max_raw_diff.max(raw_diff);
            stats.max_filtered_diff = stats.max_filtered_diff.max(filtered_diff);
            let acc_speech = py.raw_accumulated_speech.unwrap();
            let acc_silence = py.raw_accumulated_silence.unwrap();
            assert!(
                (rust.raw_accumulated_speech - acc_speech).abs() <= TIME_TOLERANCE,
                "{at}: raw_accumulated_speech"
            );
            assert!(
                (rust.raw_accumulated_silence - acc_silence).abs() <= TIME_TOLERANCE,
                "{at}: raw_accumulated_silence"
            );
            window += 1;
        }
    }
    assert_eq!(
        window,
        oracle.raw_probabilities.len(),
        "{label}: window count"
    );
    stats.events += events.len();
    stats.windows += window;
}

#[test]
fn matches_livekit_silero_vad() {
    let mut stats = Stats::default();
    let fixtures = fixtures();
    for fixture in &fixtures {
        let audio = read_wav(&fixtures_dir().join(format!("{}.wav", fixture.scenario)));
        assert_eq!(
            audio.len(),
            fixture.samples,
            "{}: wav length",
            fixture.scenario
        );
        let vad = Vad::new(options_for(&fixture.options)).unwrap();
        assert_eq!(fixture.runs.len(), 2);
        for oracle in &fixture.runs {
            let label = format!("{} chunk={}", fixture.scenario, oracle.chunk);
            let events = run(&vad, &audio, oracle.chunk, oracle.flush_after_samples);
            compare(&label, oracle, &events, &mut stats);
        }
    }
    eprintln!(
        "{} scenarios, {} events, {} windows; max |raw p diff| = {:e}, max |filtered p diff| = {:e}",
        fixtures.len(),
        stats.events,
        stats.windows,
        stats.max_raw_diff,
        stats.max_filtered_diff
    );
}

/// Without a flush the events do not depend on how the audio is chunked, so odd chunk sizes and
/// one big push must give the 20 ms oracle's events too.
#[test]
fn chunking_does_not_change_events() {
    let mut stats = Stats::default();
    for fixture in fixtures()
        .iter()
        .filter(|f| f.runs[0].flush_after_samples.is_none())
    {
        let audio = read_wav(&fixtures_dir().join(format!("{}.wav", fixture.scenario)));
        let vad = Vad::new(options_for(&fixture.options)).unwrap();
        let oracle = &fixture.runs[0];
        for chunk in [1, 333, 511, 513, audio.len().max(1)] {
            let events = run(&vad, &audio, chunk, None);
            compare(
                &format!("{} chunk={chunk}", fixture.scenario),
                oracle,
                &events,
                &mut stats,
            );
        }
    }
}

/// Streams of one `Vad` keep separate model state, even when interleaved.
#[test]
fn interleaved_streams_are_independent() {
    let fixtures = fixtures();
    let a = fixtures
        .iter()
        .find(|f| f.scenario == "s01_single")
        .unwrap();
    let b = fixtures
        .iter()
        .find(|f| f.scenario == "s02_two_utterances")
        .unwrap();
    let audio_a = read_wav(&fixtures_dir().join("s01_single.wav"));
    let audio_b = read_wav(&fixtures_dir().join("s02_two_utterances.wav"));
    let vad = Vad::new(VadOptions::monban()).unwrap();
    let (mut stream_a, mut stream_b) = (vad.stream(), vad.stream());
    let (mut events_a, mut events_b) = (Vec::new(), Vec::new());
    let mut chunks_a = audio_a.chunks(320);
    let mut chunks_b = audio_b.chunks(320);
    loop {
        let (next_a, next_b) = (chunks_a.next(), chunks_b.next());
        if next_a.is_none() && next_b.is_none() {
            break;
        }
        if let Some(part) = next_a {
            stream_a.push_into(part, &mut events_a).unwrap();
        }
        if let Some(part) = next_b {
            stream_b.push_into(part, &mut events_b).unwrap();
        }
    }
    let mut stats = Stats::default();
    compare("interleaved a", &a.runs[0], &events_a, &mut stats);
    compare("interleaved b", &b.runs[0], &events_b, &mut stats);
}
