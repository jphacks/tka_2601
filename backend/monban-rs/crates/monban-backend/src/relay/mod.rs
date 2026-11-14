//! WebSocket relay `/api/relay` (port of `relay/__init__.py`, Issue #80).
//!
//! Device -> relay: a start JSON, then protocol v2 control JSON and 16 kHz/16-bit/mono PCM.
//! Protocol v1 (the LiveKit room bridge) is not ported (Issue #81) and is refused.

pub mod runtime;
mod v2;

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use serde_json::{json, Value};
use uuid::Uuid;

use monban_policy::house_rules::Mode;

use crate::app::AppState;

pub use runtime::{
    configure_for, set_runtime_factory, OutputSink, RelayConfig, RuntimeConfig, RuntimeFactory,
    Timings, VoiceRuntime,
};

pub const CLOSE_NORMAL: u16 = 1000;
pub const CLOSE_POLICY: u16 = 1008;
pub const CLOSE_SERVER_ERROR: u16 = 1011;
pub const CLOSE_TRY_AGAIN_LATER: u16 = 1013;

/// The non-secret sentinel E84's unpaired diagnostic client sends; not a household key.
const DIAGNOSTIC_DEVICE_KEY: &str = "e84-diagnostic-unpaired";

/// `RelayErrorCode` values (the `code` of an error message).
pub mod codes {
    pub const START_TIMEOUT: &str = "start_timeout";
    pub const INVALID_START: &str = "invalid_start";
    pub const INVALID_AUDIO: &str = "invalid_audio";
    pub const INVALID_MESSAGE: &str = "invalid_message";
    pub const LIVEKIT_DISCONNECTED: &str = "livekit_disconnected";
    pub const TIME_LIMIT: &str = "time_limit";
    pub const AGENT_UNAVAILABLE: &str = "agent_unavailable";
    pub const INVALID_OUTPUT: &str = "invalid_output";
    pub const OUTPUT_LIMIT: &str = "output_limit";
    pub const INPUT_LIMIT: &str = "input_limit";
    pub const INVALID_INPUT_END: &str = "invalid_input_end";
    pub const INVALID_ACK: &str = "invalid_ack";
    pub const INVALID_PLAYBACK: &str = "invalid_playback";
    pub const INVALID_STATE: &str = "invalid_state";
    pub const EMPTY_GREETING: &str = "empty_greeting";
}

/// An error reported to the device as `{"type":"error","code","message"}` and a close code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("relay error {code}")]
pub struct RelayError {
    pub code: &'static str,
    pub message: String,
    pub close_code: u16,
}

impl RelayError {
    /// Closes with 1008 (policy), as Python's default.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), close_code: CLOSE_POLICY }
    }

    pub fn server(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), close_code: CLOSE_SERVER_ERROR }
    }
}

/// The device closed the WebSocket (Starlette's `WebSocketDisconnect`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("websocket disconnected")]
pub struct Disconnected;

/// A validated start message.
#[derive(Debug, Clone, PartialEq)]
pub struct StartMessage {
    pub protocol_version: u8,
    pub visit_id: Uuid,
    pub mode: Mode,
    /// `None` for diagnostic calls before pairing; they skip resident data and history.
    pub device_key: Option<String>,
}

/// Validate a start message the way the pydantic `StartMessage` does. Returns the names
/// of the invalid fields on failure.
pub fn parse_start(text: &str) -> Result<StartMessage, Vec<&'static str>> {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) else {
        return Err(vec![""]);
    };
    let mut invalid = Vec::new();
    if object.get("type").and_then(Value::as_str) != Some("start") {
        invalid.push("type");
    }
    // Literal[1, 2]: lax mode also takes true (== 1) and integral floats.
    let protocol_version = match object.get("protocol_version") {
        None => Some(1),
        Some(Value::Bool(true)) => Some(1),
        Some(Value::Number(number)) => number.as_f64().and_then(|value| {
            if value == 1.0 {
                Some(1)
            } else if value == 2.0 {
                Some(2)
            } else {
                None
            }
        }),
        Some(_) => None,
    };
    if protocol_version.is_none() {
        invalid.push("protocol_version");
    }
    let visit_id = object.get("visit_id").and_then(Value::as_str).and_then(|v| Uuid::parse_str(v).ok());
    if visit_id.is_none() {
        invalid.push("visit_id");
    }
    let mode = object.get("mode").and_then(Value::as_str).and_then(Mode::parse);
    if mode.is_none() {
        invalid.push("mode");
    }
    let device_key = match object.get("device_key") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(key))
            if (1..=512).contains(&key.chars().count())
                && key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) =>
        {
            Ok(Some(key.clone()))
        }
        Some(_) => Err(()),
    };
    if device_key.is_err() {
        invalid.push("device_key");
    }
    if !invalid.is_empty() {
        return Err(invalid);
    }
    Ok(StartMessage {
        protocol_version: protocol_version.expect("checked"),
        visit_id: visit_id.expect("checked"),
        mode: mode.expect("checked"),
        device_key: device_key.expect("checked").filter(|key| key != DIAGNOSTIC_DEVICE_KEY),
    })
}

/// Compact JSON, as Starlette's `send_json` writes it.
pub(crate) fn json_text(value: &Value) -> Message {
    Message::Text(serde_json::to_string(value).expect("json").into())
}

pub(crate) fn close_message(code: u16) -> Message {
    Message::Close(Some(CloseFrame { code, reason: "".into() }))
}

/// Tell a device that every relay slot is taken, then close with 1013.
pub async fn reject_busy(socket: &mut WebSocket) {
    let message = json!({"type": "error", "code": "busy", "message": "混み合っています。少し待って接続し直してください。"});
    let _ = socket.send(json_text(&message)).await;
    let _ = socket.send(close_message(CLOSE_TRY_AGAIN_LATER)).await;
}

/// Send the error message and close; a peer that is already gone is ignored.
pub(crate) async fn send_error(socket: &mut WebSocket, error: &RelayError) {
    let message = json!({"type": "error", "code": error.code, "message": error.message});
    if socket.send(json_text(&message)).await.is_ok() {
        let _ = socket.send(close_message(error.close_code)).await;
    }
}

enum Received {
    Text(String),
    Binary,
}

/// The next text or binary message; `None` once the device disconnected.
async fn next_data(socket: &mut WebSocket) -> Option<Received> {
    loop {
        match socket.recv().await {
            Some(Ok(Message::Text(text))) => return Some(Received::Text(text.to_string())),
            Some(Ok(Message::Binary(_))) => return Some(Received::Binary),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return None,
        }
    }
}

async fn receive_start(state: &AppState, socket: &mut WebSocket) -> Result<Option<StartMessage>, RelayError> {
    let timeout = Duration::from_secs_f64(state.settings.relay_start_timeout_seconds);
    let message = match tokio::time::timeout(timeout, next_data(socket)).await {
        Err(_) => return Err(RelayError::new(codes::START_TIMEOUT, "開始の JSON が届きません。")),
        Ok(None) => return Ok(None),
        Ok(Some(message)) => message,
    };
    let text = match message {
        Received::Text(text) => text,
        Received::Binary => String::new(),
    };
    parse_start(&text).map(Some).map_err(|fields| {
        tracing::warn!("relay invalid start fields={fields:?}");
        RelayError::new(codes::INVALID_START, "開始の JSON の形が違います。")
    })
}

/// Run one conversation. The caller has authenticated and accepted the WebSocket.
pub async fn serve(state: AppState, mut socket: WebSocket) {
    let start = match receive_start(&state, &mut socket).await {
        Ok(Some(start)) => start,
        Ok(None) => return,
        Err(error) => {
            tracing::info!("relay error code={}", error.code);
            send_error(&mut socket, &error).await;
            return;
        }
    };
    tracing::info!("relay accepted protocol={}", start.protocol_version);
    if start.protocol_version == 2 {
        v2::serve_v2(state, socket, start).await;
        return;
    }
    // Protocol v1 joins a LiveKit room with the RTC agent, which is not ported (#81).
    let error = RelayError::server(codes::AGENT_UNAVAILABLE, "音声エージェントを開始できません。");
    tracing::info!("relay error code={} (protocol v1 is not available)", error.code);
    send_error(&mut socket, &error).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "12345678-1234-5678-1234-567812345678";

    fn start(extra: Value) -> String {
        let mut base = json!({"type": "start", "visit_id": UUID, "mode": "normal"});
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base.to_string()
    }

    #[test]
    fn start_accepts_what_pydantic_accepts() {
        let parsed = parse_start(&start(json!({}))).unwrap();
        assert_eq!(parsed.protocol_version, 1);
        assert_eq!(parsed.mode, Mode::Normal);
        assert_eq!(parsed.device_key, None);
        for (value, expected) in [(json!(true), 1), (json!(2), 2), (json!(2.0), 2), (json!(1), 1)] {
            let parsed = parse_start(&start(json!({"protocol_version": value}))).unwrap();
            assert_eq!(parsed.protocol_version, expected);
        }
        for visit_id in [UUID.replace('-', ""), format!("{{{UUID}}}"), format!("urn:uuid:{UUID}"), UUID.to_uppercase()] {
            assert!(parse_start(&start(json!({"visit_id": visit_id}))).is_ok());
        }
        assert!(parse_start(&start(json!({"device_key": null}))).is_ok());
        let key = "a".repeat(512);
        assert_eq!(parse_start(&start(json!({"device_key": key}))).unwrap().device_key, Some(key));
        let duplicated = format!(r#"{{"type":"start","visit_id":"{UUID}","mode":"normal","mode":"away"}}"#);
        assert_eq!(parse_start(&duplicated).unwrap().mode, Mode::Away);
    }

    #[test]
    fn start_rejects_what_pydantic_rejects() {
        for extra in [
            json!({"protocol_version": "2"}),
            json!({"protocol_version": 3}),
            json!({"protocol_version": false}),
            json!({"protocol_version": null}),
            json!({"mode": "Normal"}),
            json!({"mode": "off"}),
            json!({"visit_id": "not-a-uuid"}),
            json!({"visit_id": 123}),
            json!({"device_key": ""}),
            json!({"device_key": "key with spaces"}),
            json!({"device_key": "é"}),
            json!({"device_key": "a".repeat(513)}),
            json!({"type": "START"}),
        ] {
            assert!(parse_start(&start(extra.clone())).is_err(), "{extra}");
        }
        let without_mode = json!({"type": "start", "visit_id": UUID}).to_string();
        assert!(parse_start(&without_mode).is_err());
        for raw in ["", "null", "[]", "{"] {
            assert!(parse_start(raw).is_err());
        }
    }

    #[test]
    fn diagnostic_sentinel_has_no_device_key() {
        let parsed = parse_start(&start(json!({"device_key": DIAGNOSTIC_DEVICE_KEY}))).unwrap();
        assert_eq!(parsed.device_key, None);
    }
}
