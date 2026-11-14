//! A stand-in XIAO for checking a deployed server end to end with the real models.
//!
//! Run inside the API container (it reads the same environment):
//!     monban-relay-probe ["ヤマト運輸です。お荷物のお届けです。"]
//! It synthesizes the visitor's words with the configured TTS, opens `/api/relay` with
//! protocol v2 as the door device would (unpaired, so no visit history is written), plays
//! the greeting, sends the words as one utterance and prints the transcripts and timings.

use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use monban_backend::config::Settings;
use monban_backend::voice::clients::resample::resample_to_device;
use monban_backend::voice::clients::tts::SpeechCppTts;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_json(socket: &mut Socket, deadline: Duration) -> anyhow::Result<Value> {
    loop {
        let message = tokio::time::timeout(deadline, socket.next())
            .await?
            .ok_or_else(|| anyhow::anyhow!("socket closed"))??;
        match message {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(&text)?;
                if value["type"] == "transcript" {
                    println!("  transcript {}: {}", value["speaker"].as_str().unwrap_or(""), value["text"].as_str().unwrap_or(""));
                    continue;
                }
                if value["type"] == "error" {
                    anyhow::bail!("server error: {value}");
                }
                return Ok(value);
            }
            Message::Close(frame) => anyhow::bail!("closed: {frame:?}"),
            _ => anyhow::bail!("unexpected binary frame"),
        }
    }
}

/// Receive one reply (output_start .. output_end), acknowledge every frame, report playback.
async fn play(socket: &mut Socket, turn: u64, started: Instant) -> anyhow::Result<bool> {
    let first = next_json(socket, Duration::from_secs(90)).await?;
    if first["type"] == "no_reply" {
        println!("  turn {turn}: no reply");
        return Ok(false);
    }
    anyhow::ensure!(first["type"] == "output_start", "expected output_start, got {first}");
    println!("  turn {turn}: first audio after {} ms", started.elapsed().as_millis());
    let mut frames = 0u64;
    let mut samples = 0u64;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(30), socket.next())
            .await?
            .ok_or_else(|| anyhow::anyhow!("socket closed"))??;
        match message {
            Message::Binary(pcm) => {
                frames += 1;
                samples += pcm.len() as u64 / 2;
                let ack = json!({"type": "audio_ack", "turn_id": turn, "output_id": turn, "frames": frames});
                socket.send(Message::Text(ack.to_string().into())).await?;
            }
            Message::Text(text) => {
                let value: Value = serde_json::from_str(&text)?;
                if value["type"] == "transcript" {
                    println!("  transcript {}: {}", value["speaker"].as_str().unwrap_or(""), value["text"].as_str().unwrap_or(""));
                    continue;
                }
                anyhow::ensure!(value["type"] == "output_end", "expected output_end, got {value}");
                println!("  turn {turn}: {frames} frames, {:.2} s of audio, end_call={}", samples as f64 / 16000.0, value["end_call"]);
                let done = json!({"type": "playback_done", "turn_id": turn, "output_id": turn, "frames": frames, "samples": samples});
                socket.send(Message::Text(done.to_string().into())).await?;
                return Ok(value["end_call"] == true);
            }
            other => anyhow::bail!("unexpected message {other:?}"),
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let words = std::env::args().nth(1).unwrap_or_else(|| "ヤマト運輸です。お荷物のお届けです。".into());
    let settings = std::sync::Arc::new(Settings::from_process_env()?);
    let port = std::env::var("MONBAN_PORT").unwrap_or_else(|_| "8093".into());

    let started = Instant::now();
    let tts = SpeechCppTts::new(settings.clone());
    let speech = resample_to_device(&tts.synthesize(&words).await?, tts.sample_rate());
    println!("visitor audio: {:.2} s synthesized in {} ms", speech.len() as f64 / 32000.0, started.elapsed().as_millis());

    let mut request = format!("ws://127.0.0.1:{port}/api/relay").into_client_request()?;
    request.headers_mut().insert("authorization", format!("Bearer {}", settings.api_key).parse()?);
    // Production accepts only WSS; the Cloudflare tunnel marks forwarded requests this way.
    request.headers_mut().insert("x-forwarded-proto", "https".parse()?);
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await?;
    let visit_id = uuid::Uuid::new_v4();
    let start = json!({"type": "start", "protocol_version": 2, "visit_id": visit_id, "mode": "normal"});
    socket.send(Message::Text(start.to_string().into())).await?;
    let ready = next_json(&mut socket, Duration::from_secs(60)).await?;
    anyhow::ensure!(ready["type"] == "ready", "expected ready, got {ready}");
    println!("ready (protocol {})", ready["protocol_version"]);

    socket.send(Message::Text(json!({"type": "call_started", "turn_id": 0}).to_string().into())).await?;
    play(&mut socket, 0, Instant::now()).await?;
    let listen = next_json(&mut socket, Duration::from_secs(30)).await?;
    anyhow::ensure!(listen["type"] == "listen", "expected listen, got {listen}");

    let turn = listen["turn_id"].as_u64().unwrap_or(1);
    socket.send(Message::Text(json!({"type": "input_start", "turn_id": turn}).to_string().into())).await?;
    let mut frames = 0u64;
    for chunk in speech.chunks(640) {
        let mut frame = chunk.to_vec();
        frame.resize(640, 0);
        socket.send(Message::Binary(frame.into())).await?;
        frames += 1;
    }
    let end = json!({"type": "input_end", "turn_id": turn, "frames": frames, "samples": frames * 320, "reason": "silence"});
    socket.send(Message::Text(end.to_string().into())).await?;
    let spoken = Instant::now();
    play(&mut socket, turn, spoken).await?;
    println!("  turn {turn}: reply finished {} ms after the utterance ended", spoken.elapsed().as_millis());

    socket.send(Message::Text(json!({"type": "end"}).to_string().into())).await?;
    let _ = tokio::time::timeout(Duration::from_secs(5), socket.next()).await;
    println!("ok");
    Ok(())
}
