//! Measures VAD processing time per second of audio on the oracle fixtures.
//!
//! `cargo run --release -p monban-vad --example throughput`

use std::path::Path;
use std::time::{Duration, Instant};

use monban_vad::{Vad, VadOptions, SAMPLE_RATE, WINDOW_SAMPLES};

fn read_wav_samples(path: &Path) -> Vec<i16> {
    // The fixtures are plain 44-byte-header PCM files written by Python's `wave`.
    let bytes = std::fs::read(path).unwrap();
    bytes[44..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut audio = Vec::new();
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect();
    paths.sort();
    for path in &paths {
        audio.push(read_wav_samples(path));
    }
    let total_samples: usize = audio.iter().map(Vec::len).sum();
    let seconds = total_samples as f64 / f64::from(SAMPLE_RATE);

    let started = Instant::now();
    let vad = Vad::new(VadOptions::monban()).unwrap();
    println!("model load: {:?}", started.elapsed());

    let rounds = 5;
    let mut best = Duration::MAX;
    for _ in 0..rounds {
        let started = Instant::now();
        for samples in &audio {
            let mut stream = vad.stream();
            for chunk in samples.chunks(320) {
                std::hint::black_box(stream.push(chunk).unwrap());
            }
        }
        best = best.min(started.elapsed());
    }
    let windows = total_samples / WINDOW_SAMPLES;
    println!(
        "{} files, {seconds:.1} s of audio: best of {rounds} = {best:?} -> {:.2} ms per second of audio, {:.1} us per window, {:.0}x realtime",
        paths.len(),
        best.as_secs_f64() * 1000.0 / seconds,
        best.as_secs_f64() * 1e6 / windows as f64,
        seconds / best.as_secs_f64()
    );
}
