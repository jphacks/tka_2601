//! Writes one visit and its conversation to Supabase (port of `persistence/supabase_history.py`).
//!
//! The relay holds no secret key; it calls the device endpoint with the device key from the
//! start message. Text only; audio and images are never stored. Any failure is logged and
//! never reaches the conversation.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::config::Settings;

pub const MAX_COMPANY_CHARS: usize = 100;
const MODES: [&str; 4] = ["normal", "omakase", "away", "off"];
/// Only written once the conversation reached ready and then finished.
const STATUS: &str = "ended";
const END_REASONS: [&str; 8] =
    ["closing", "silence", "time_limit", "fallback", "safe", "mode_off", "resident", "no_answer"];
const INTENTS: [&str; 5] = ["delivery", "sales", "service", "emergency", "unknown"];
const OUTCOMES: [&str; 6] =
    ["leave_at_door", "delivery_slip", "declined", "callback", "escalated", "none"];
const SPEAKERS: [&str; 2] = ["visitor", "ai"];

/// One transcript line collected during a call.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Utterance {
    pub speaker: String,
    pub text: String,
    pub spoken_at: String,
}

impl Utterance {
    pub fn now(speaker: &str, text: &str) -> Self {
        Self { speaker: speaker.into(), text: text.into(), spoken_at: utc_now_iso() }
    }
}

/// Current time as ISO-8601 with milliseconds and the `Z` designator.
pub fn utc_now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn checked_company(raw: Option<&Value>) -> Option<String> {
    let company: String = raw?.as_str()?.trim().chars().take(MAX_COMPANY_CHARS).collect();
    (!company.is_empty()).then_some(company)
}

/// Accept a listed value; drop unknown or malformed ones instead of sending them.
fn checked_choice(key: &str, raw: Option<&Value>, allowed: &[&str]) -> Option<String> {
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) if allowed.contains(&value.as_str()) => Some(value.clone()),
        Some(_) => {
            tracing::warn!("visit history field is unknown and is dropped: {key}");
            None
        }
    }
}

/// Number the utterances by arrival and keep only valid transcripts.
pub fn visit_messages(utterances: &[Utterance]) -> Vec<Value> {
    utterances
        .iter()
        .enumerate()
        .filter(|(_, u)| SPEAKERS.contains(&u.speaker.as_str()) && !u.text.trim().is_empty())
        .map(|(index, u)| {
            json!({"seq": index + 1, "speaker": u.speaker, "text": u.text, "spoken_at": u.spoken_at})
        })
        .collect()
}

/// Assemble the PUT body from the start, the collected utterances and how it ended.
pub fn build_visit_payload(
    mode: &str,
    chimed_at: &str,
    answered_at: &str,
    ended_at: &str,
    utterances: &[Utterance],
    end_json: Option<&Value>,
    end_code: Option<&str>,
) -> Value {
    let empty = Map::new();
    let end = end_json.and_then(Value::as_object).unwrap_or(&empty);
    let mut payload = Map::new();
    payload.insert("chimed_at".into(), chimed_at.into());
    payload.insert(
        "mode".into(),
        (if MODES.contains(&mode) { mode } else { "normal" }).into(),
    );
    payload.insert("status".into(), STATUS.into());
    payload.insert("answered_at".into(), answered_at.into());
    payload.insert("ended_at".into(), ended_at.into());
    payload.insert("messages".into(), Value::Array(visit_messages(utterances)));
    match end_code {
        Some("time_limit") => {
            payload.insert("end_reason".into(), "time_limit".into());
        }
        Some(code) if code != "end" => {
            payload.insert("end_reason".into(), "safe".into());
        }
        _ => {
            if let Some(reason) = checked_choice("end_reason", end.get("end_reason"), &END_REASONS) {
                payload.insert("end_reason".into(), reason.into());
            }
        }
    }
    for (key, allowed) in [("intent", &INTENTS[..]), ("outcome", &OUTCOMES[..])] {
        if let Some(value) = checked_choice(key, end.get(key), allowed) {
            payload.insert(key.into(), value.into());
        }
    }
    if let Some(company) = checked_company(end.get("company")) {
        payload.insert("company".into(), company.into());
    }
    Value::Object(payload)
}

/// Sends the visit history PUT.
#[derive(Clone)]
pub struct VisitHistory {
    http: reqwest::Client,
    supabase_url: String,
    anon_key: String,
    timeout: Duration,
}

pub struct VisitRecord<'a> {
    pub device_key: &'a str,
    pub visit_id: Uuid,
    pub mode: &'a str,
    pub chimed_at: &'a str,
    pub answered_at: &'a str,
    pub utterances: &'a [Utterance],
    pub end_code: Option<&'a str>,
    pub end_json: Option<&'a Value>,
}

impl VisitHistory {
    pub fn new(http: reqwest::Client, settings: &Settings) -> Self {
        Self {
            http,
            supabase_url: settings.supabase_url.clone(),
            anon_key: settings.supabase_anon_key.clone(),
            timeout: Duration::from_secs_f64(settings.visit_write_timeout_seconds),
        }
    }

    /// PUT one visit to the device API; return the response or None. Never fails.
    pub async fn put_visit(&self, device_key: &str, visit_id: Uuid, payload: &Value) -> Option<Value> {
        if self.supabase_url.is_empty() || self.anon_key.is_empty() {
            tracing::warn!("Supabase URL or public API key is not set; visit history was not written");
            return None;
        }
        let url = format!("{}/functions/v1/device/visits/{}", self.supabase_url, visit_id.hyphenated());
        let response = self
            .http
            .put(url)
            .header("apikey", &self.anon_key)
            .header("Authorization", format!("Bearer {device_key}"))
            .json(payload)
            .timeout(self.timeout)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(
                    "visit history PUT failed: {}",
                    super::device_api::reqwest_error_name(&error)
                );
                return None;
            }
        };
        if response.status().as_u16() != 200 {
            tracing::warn!("visit history PUT failed: status={}", response.status().as_u16());
            return None;
        }
        match response.bytes().await.map(|body| serde_json::from_slice::<Value>(&body)) {
            Ok(Ok(value)) => Some(value),
            _ => {
                tracing::warn!("visit history PUT failed: ValueError");
                None
            }
        }
    }

    /// Build and send the single PUT that records one finished conversation.
    pub async fn write_visit(&self, record: VisitRecord<'_>) -> Option<Value> {
        let payload = build_visit_payload(
            record.mode,
            record.chimed_at,
            record.answered_at,
            &utc_now_iso(),
            record.utterances,
            record.end_json,
            record.end_code,
        );
        self.put_visit(record.device_key, record.visit_id, &payload).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utterance(speaker: &str, text: &str) -> Utterance {
        Utterance { speaker: speaker.into(), text: text.into(), spoken_at: "t".into() }
    }

    #[test]
    fn messages_keep_arrival_numbers_and_drop_invalid_rows() {
        let rows = [utterance("visitor", "宅配です"), utterance("bot", "x"), utterance("ai", "  "), utterance("ai", "はい")];
        let messages = visit_messages(&rows);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["seq"], 1);
        assert_eq!(messages[1]["seq"], 4);
    }

    #[test]
    fn end_code_sets_reason() {
        let payload = build_visit_payload("away", "a", "b", "c", &[], None, Some("time_limit"));
        assert_eq!(payload["end_reason"], "time_limit");
        assert_eq!(payload["mode"], "away");
        let payload = build_visit_payload("bogus", "a", "b", "c", &[], None, Some("disconnected"));
        assert_eq!(payload["end_reason"], "safe");
        assert_eq!(payload["mode"], "normal");
        let payload = build_visit_payload("normal", "a", "b", "c", &[], None, None);
        assert!(payload.get("end_reason").is_none());
        assert_eq!(payload["status"], "ended");
    }

    #[test]
    fn end_json_fields_are_checked() {
        let end = json!({"outcome": "escalated", "intent": "spam", "company": "  ヤマト運輸  ", "end_reason": "closing"});
        let payload = build_visit_payload("normal", "a", "b", "c", &[], Some(&end), Some("end"));
        assert_eq!(payload["outcome"], "escalated");
        assert!(payload.get("intent").is_none());
        assert_eq!(payload["company"], "ヤマト運輸");
        assert_eq!(payload["end_reason"], "closing");
    }

    #[test]
    fn timestamps_use_z_and_milliseconds() {
        let value = utc_now_iso();
        assert!(value.ends_with('Z'));
        assert_eq!(value.len(), "2026-11-14T00:00:00.000Z".len());
    }
}
