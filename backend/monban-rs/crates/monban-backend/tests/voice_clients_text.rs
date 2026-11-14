//! The TTS text helpers against outputs recorded from the Python implementation
//! (`tools/voice_oracle/text_oracle.py` → `tests/fixtures/voice_clients/text.json`).

use monban_backend::voice::clients::text::{
    filter_emoji, split_sentences, trim_delayed_audio_tail, MarkdownFilter, TtsTextFilter,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn oracle() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/voice_clients/text.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("oracle file")).expect("oracle JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_string()).collect()
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn markdown_and_emoji_filters_match_python_chunk_by_chunk() {
    let oracle = oracle();
    let cases = oracle["markdown"].as_array().unwrap();
    assert!(cases.len() > 300);
    let mut failures = Vec::new();
    for case in cases {
        let input = strings(&case["input"]);

        let mut markdown = MarkdownFilter::new();
        let mut md_out: Vec<String> = input.iter().flat_map(|chunk| markdown.push(chunk)).collect();
        md_out.extend(markdown.finish());

        let mut tts = TtsTextFilter::new();
        let mut tts_out: Vec<String> = input.iter().flat_map(|chunk| tts.push(chunk)).collect();
        tts_out.extend(tts.finish());

        if md_out != strings(&case["markdown"]) || tts_out != strings(&case["tts_text"]) {
            failures.push(format!(
                "input {:?}\n  python markdown {:?}\n  rust   markdown {:?}\n  python tts {:?}\n  rust   tts {:?}",
                input, case["markdown"], md_out, case["tts_text"], tts_out
            ));
        }
    }
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn emoji_filter_matches_python() {
    for case in oracle()["emoji"].as_array().unwrap() {
        assert_eq!(filter_emoji(case["input"].as_str().unwrap()), case["output"].as_str().unwrap());
    }
}

#[test]
fn sentence_split_matches_python() {
    for case in oracle()["sentences"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        assert_eq!(split_sentences(input), strings(&case["output"]), "input {input:?}");
    }
}

/// `text_oracle.waveform`: integer-only test signals.
fn waveform(segments: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    let mut seed: u64 = 12345;
    for segment in segments.as_array().unwrap() {
        let kind = segment[0].as_str().unwrap();
        let samples = segment[1].as_u64().unwrap();
        let amplitude = segment[2].as_i64().unwrap();
        for i in 0..samples {
            let value = match kind {
                "square" => {
                    if (i / 20) % 2 == 0 {
                        amplitude
                    } else {
                        -amplitude
                    }
                }
                "noise" => {
                    seed = (seed * 1_103_515_245 + 12345) % 2_147_483_648;
                    ((seed >> 8) as i64) % (2 * amplitude + 1) - amplitude
                }
                _ => 0,
            };
            out.extend_from_slice(&(value as i16).to_le_bytes());
        }
    }
    out
}

#[test]
fn delayed_tail_trim_matches_python() {
    let oracle = oracle();
    let cases = oracle["trim"].as_array().unwrap();
    let mut trimmed_any = false;
    for case in cases {
        let mut pcm = waveform(&case["segments"]);
        if case.get("extra_byte").and_then(Value::as_bool) == Some(true) {
            pcm.push(1);
        }
        assert_eq!(pcm.len() as u64, case["input_bytes"].as_u64().unwrap());
        assert_eq!(sha256(&pcm), case["input_sha256"].as_str().unwrap(), "regenerated input differs");
        let rate = case["sample_rate"].as_u64().unwrap() as u32;
        let out = trim_delayed_audio_tail(&pcm, rate, case["text"].as_str().unwrap());
        assert_eq!(out.len() as u64, case["output_bytes"].as_u64().unwrap(), "case {case}");
        assert_eq!(sha256(out), case["output_sha256"].as_str().unwrap());
        trimmed_any |= out.len() < pcm.len();
    }
    assert!(trimmed_any);
}
