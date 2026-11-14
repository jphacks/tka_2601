//! Opt-in loopback latency experiment; never connects to a deployed service.
use super::*;
use futures::SinkExt;
use monban_backend::app::{router, AppInner};
use monban_backend::relay::{configure_for, RelayConfig, Timings};
use monban_backend::services::LiveServices;
use monban_backend::voice::runtime::DeviceRuntimeFactory;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Events = Arc<Mutex<Vec<Value>>>;

fn record(events: &Events, started: Instant, name: &str, detail: Value) {
    events.lock().unwrap().push(json!({"event": name, "at_ms": started.elapsed().as_secs_f64() * 1000.0, "detail": detail}));
}

async fn control(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(45), socket.next()).await.unwrap().unwrap().unwrap() {
            Message::Text(text) => {
                let v: Value = serde_json::from_str(&text).unwrap();
                assert_ne!(v["type"], "error", "{v}");
                if v["type"] != "transcript" { return v; }
            }
            other => panic!("expected control, got {other:?}"),
        }
    }
}

async fn play(socket: &mut Socket, turn: u64, events: &Events, started: Instant, label: &str) -> Value {
    let sent = Instant::now();
    let start = control(socket).await;
    assert_eq!(start["type"], "output_start");
    let output_start_ms = sent.elapsed().as_secs_f64() * 1000.0;
    record(events, started, "client_output_start", json!({"label": label}));
    let mut first_pcm_ms = None;
    let mut frames = 0u64;
    let mut samples = 0u64;
    loop {
        match tokio::time::timeout(Duration::from_secs(45), socket.next()).await.unwrap().unwrap().unwrap() {
            Message::Binary(pcm) => {
                if first_pcm_ms.is_none() {
                    first_pcm_ms = Some(sent.elapsed().as_secs_f64() * 1000.0);
                    record(events, started, "client_first_pcm", json!({"label": label}));
                }
                frames += 1;
                samples += pcm.len() as u64 / 2;
                socket.send(Message::Text(json!({"type": "audio_ack", "turn_id": turn,
                    "output_id": turn, "frames": frames}).to_string().into())).await.unwrap();
            }
            Message::Text(text) => {
                let v: Value = serde_json::from_str(&text).unwrap();
                if v["type"] == "transcript" { continue; }
                assert_eq!(v["type"], "output_end", "{v}");
                assert_eq!(v["frames"], frames);
                assert_eq!(v["samples"], samples);
                let elapsed_ms = sent.elapsed().as_secs_f64() * 1000.0;
                socket.send(Message::Text(json!({"type": "playback_done", "turn_id": turn,
                    "output_id": turn, "frames": frames, "samples": samples}).to_string().into())).await.unwrap();
                return json!({"label": label, "output_start_ms": output_start_ms,
                    "first_pcm_ms": first_pcm_ms, "output_end_ms": elapsed_ms, "frames": frames,
                    "audio_seconds": samples as f64 / 16000.0});
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// Run with --ignored --nocapture. Fixture paths are optional and must be local PCM.
/// MONBAN_LATENCY_TTFA_MS and MONBAN_LATENCY_DONE_MS control each mock TTS sentence.
#[tokio::test]
#[ignore = "wall-clock loopback experiment; opt in with --ignored"]
async fn relay_latency_with_slow_tts_and_fixed_greeting_cache() {
    let _ = tracing_subscriber::fmt().with_ansi(false).with_target(false)
        .with_env_filter("monban_backend=info").try_init();
    let started = Instant::now();
    let events: Events = Arc::default();
    let output = std::env::var("MONBAN_LATENCY_OUTPUT_PCM").ok()
        .map(|p| std::fs::read(p).unwrap()).unwrap_or_else(|| [1u8, 0].repeat(4800));
    assert!(!output.is_empty() && output.len().is_multiple_of(2));
    let input = std::env::var("MONBAN_LATENCY_INPUT_PCM").ok()
        .map(|p| std::fs::read(p).unwrap()).unwrap_or_else(|| [1u8, 0].repeat(1600));
    let ttfa = std::env::var("MONBAN_LATENCY_TTFA_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(250);
    let done = std::env::var("MONBAN_LATENCY_DONE_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(8000);
    assert!(done >= ttfa && done < 30000);
    let log = events.clone();
    let server = fake(Arc::new(move |index, req| {
        let events = log.clone();
        let output = output.clone();
        async move {
            match req.path.as_str() {
                "/v1/audio/speech" => {
                    record(&events, started, "mock_tts_post", json!({"index": index, "chars": req.body["input"].as_str().unwrap().chars().count()}));
                    let delta = format!("data: {}\n\n", json!({"type": "speech.audio.delta",
                        "delta": base64::engine::general_purpose::STANDARD.encode(output)})).into_bytes();
                    let stream = futures::stream::unfold(0u8, move |phase| {
                        let events = events.clone();
                        let delta = delta.clone();
                        async move {
                            match phase {
                                0 => {
                                    tokio::time::sleep(Duration::from_millis(ttfa)).await;
                                    record(&events, started, "mock_tts_first_pcm", json!({"index": index}));
                                    Some((Ok::<_, Infallible>(bytes::Bytes::from(delta)), 1))
                                }
                                1 => {
                                    tokio::time::sleep(Duration::from_millis(done - ttfa)).await;
                                    record(&events, started, "mock_tts_done", json!({"index": index}));
                                    Some((Ok(bytes::Bytes::from_static(b"data: {\"type\":\"speech.audio.done\"}\n\n")), 2))
                                }
                                _ => None,
                            }
                        }
                    });
                    response(200, "text/event-stream", Body::from_stream(stream))
                }
                "/v1/audio/transcriptions" => {
                    record(&events, started, "mock_asr_post", json!({"fixture_bytes": req.body["file"]["bytes"]}));
                    response(200, "application/json", json!({"text": "スタッフの方に確認してほしいことがあります。"}).to_string())
                }
                "/v1/chat/completions" => {
                    record(&events, started, "mock_llm_post", Value::Null);
                    let text = json!({"choices": [{"delta": {"content": "担当者に確認します。少々お待ちください。"}}]});
                    chunked("text/event-stream", vec![format!("data: {text}\n\ndata: [DONE]\n\n").into_bytes()])
                }
                "/functions/v1/device/settings" => response(200, "application/json", json!({
                    "away_leave_at_door": false, "extra_instructions": "", "paired": true,
                    "mode": "normal", "shop": {"name": "Loopback test shop", "greeting": ""}
                }).to_string()),
                "/functions/v1/device/reservations" => response(200, "application/json", "{\"reservations\":[]}"),
                _ if req.path.starts_with("/functions/v1/device/visits/") => response(200, "application/json", "{\"ok\":true}"),
                _ => panic!("non-loopback upstream route {}", req.path),
            }
        }.boxed()
    })).await;
    let settings = settings_for(&server.base, &[("DOOR_WARMUP", "1"),
        ("DOOR_TTS_SAMPLE_RATE", "48000"), ("DOOR_SUPABASE_URL", &server.base),
        ("DOOR_SUPABASE_ANON_KEY", "loopback-anon")]);
    let models = Arc::new(monban_backend::voice::adapters::live_models(settings.clone(), reqwest::Client::new()));
    // Wait only until the reception prewarm starts, not until it has completed.
    tokio::time::timeout(Duration::from_secs(35), async {
        while server.count("/v1/audio/speech") < 2 { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    let services = Arc::new(LiveServices::new(settings.clone(), reqwest::Client::new()));
    let state = Arc::new(AppInner::new(settings, reqwest::Client::new(), services));
    configure_for(&state, RelayConfig { factory: Arc::new(DeviceRuntimeFactory { models }), timings: Timings::default() });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = router(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut outcomes = Vec::new();
    for call in 0..2 {
        let mut req = format!("ws://{address}/api/relay").into_client_request().unwrap();
        req.headers_mut().insert("authorization", format!("Bearer {}", "k".repeat(40)).parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(req).await.unwrap();
        socket.send(Message::Text(json!({"type": "start", "protocol_version": 2,
            "visit_id": uuid::Uuid::new_v4(), "mode": "normal", "device_key": "loopback-device"}).to_string().into())).await.unwrap();
        assert_eq!(control(&mut socket).await["type"], "ready");
        let before = server.count("/v1/audio/speech");
        socket.send(Message::Text(json!({"type": "call_started", "turn_id": 0}).to_string().into())).await.unwrap();
        let label = if call == 0 { "greeting_while_prewarm_inflight" } else { "greeting_cache_hit" };
        let mut outcome = play(&mut socket, 0, &events, started, label).await;
        outcome["additional_tts_posts"] = json!(server.count("/v1/audio/speech") - before);
        outcomes.push(outcome);
        let listen = control(&mut socket).await;
        assert_eq!(listen["type"], "listen");
        if call == 1 {
            let turn = listen["turn_id"].as_u64().unwrap();
            socket.send(Message::Text(json!({"type": "input_start", "turn_id": turn}).to_string().into())).await.unwrap();
            let mut frames = 0;
            for chunk in input.chunks(640) {
                let mut pcm = chunk.to_vec(); pcm.resize(640, 0);
                socket.send(Message::Binary(pcm.into())).await.unwrap(); frames += 1;
            }
            socket.send(Message::Text(json!({"type": "input_end", "turn_id": turn,
                "frames": frames, "samples": frames * 320, "reason": "silence"}).to_string().into())).await.unwrap();
            outcomes.push(play(&mut socket, turn, &events, started, "uncached_reply").await);
            assert_eq!(control(&mut socket).await["type"], "listen");
        }
        socket.send(Message::Text(json!({"type": "end"}).to_string().into())).await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), socket.next()).await;
    }
    assert!(outcomes[0]["first_pcm_ms"].as_f64().unwrap() >= done.saturating_mul(2).saturating_sub(500) as f64);
    assert!(outcomes[1]["first_pcm_ms"].as_f64().unwrap() < 1000.0);
    assert_eq!(outcomes[1]["additional_tts_posts"], 0);
    let report = json!({"scope": "loopback WS, real relay/runtime/Speaker/TTS client, mocked upstreams; no TLS/GPU/device",
        "tts_ttfa_ms_per_sentence": ttfa, "tts_done_ms_per_sentence": done,
        "input_pcm_bytes": input.len(), "outcomes": outcomes, "events": events.lock().unwrap().clone()});
    println!("RELAY_LATENCY_RESULT={report}");
    if let Ok(path) = std::env::var("MONBAN_LATENCY_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    task.abort();
}
