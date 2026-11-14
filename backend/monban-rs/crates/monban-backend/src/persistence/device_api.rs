//! Client for the Supabase Edge Function `device` (port of `persistence/device_api.py`).
//!
//! The backend holds no service-role key: it calls the same device endpoint the paired
//! device uses, authenticated with the device key, so Supabase decides which household and
//! shop the call belongs to.

use std::time::Duration;

use chrono::{DateTime, Datelike, FixedOffset, TimeZone};
use futures::StreamExt;
use serde_json::{Map, Value};

use monban_policy::house_rules::HouseSettings;

use crate::config::Settings;

pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// `business_hours.day` follows JavaScript `getDay()` (Sunday = 0).
const WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct DeviceApiError {
    pub status: Option<u16>,
    pub message: String,
}

impl DeviceApiError {
    fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        let message = message.into();
        let message = if message.is_empty() {
            format!("device API failed status={}", status.map_or("None".into(), |s| s.to_string()))
        } else {
            message
        };
        Self { status, message }
    }
}

/// Shop settings for a household that is a store (`shop_profiles` in Supabase).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShopProfile {
    pub name: String,
    pub business_type: String,
    pub tone: String,
    pub greeting: String,
    pub business_hours: Vec<Map<String, Value>>,
    pub walk_in_policy: String,
    pub reservation_provider: String,
    pub services: Vec<Map<String, Value>>,
}

impl ShopProfile {
    pub fn from_json(raw: &Value) -> Option<ShopProfile> {
        let raw = raw.as_object()?;
        let text = |key: &str| -> String {
            raw.get(key)
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
                .unwrap_or_default()
        };
        let rows = |key: &str| -> Vec<Map<String, Value>> {
            raw.get(key)
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(|item| item.as_object().cloned()).collect())
                .unwrap_or_default()
        };
        Some(ShopProfile {
            name: text("name"),
            business_type: text("business_type"),
            tone: text("tone"),
            greeting: text("greeting"),
            business_hours: rows("business_hours"),
            walk_in_policy: text("walk_in_policy"),
            reservation_provider: text("reservation_provider"),
            services: rows("services"),
        })
    }

    pub fn to_json(&self) -> Value {
        let rows = |items: &[Map<String, Value>]| {
            Value::Array(items.iter().cloned().map(Value::Object).collect())
        };
        serde_json::json!({
            "name": self.name,
            "business_type": self.business_type,
            "tone": self.tone,
            "greeting": self.greeting,
            "business_hours": rows(&self.business_hours),
            "walk_in_policy": self.walk_in_policy,
            "reservation_provider": self.reservation_provider,
            "services": rows(&self.services),
        })
    }

    /// Map the shop to the reception prompt's public fields (see `store_context`).
    /// Keys appear in the order Python inserts them.
    pub fn public_context<Tz: TimeZone>(&self, today: &DateTime<Tz>) -> Vec<(String, String)> {
        let mut context: Vec<(String, String)> = Vec::new();
        let set = |context: &mut Vec<(String, String)>, key: &str, value: String| {
            if let Some(slot) = context.iter_mut().find(|(k, _)| k == key) {
                slot.1 = value;
            } else {
                context.push((key.to_string(), value));
            }
        };
        if !self.name.is_empty() {
            set(&mut context, "shop_name", take_chars(&self.name, 500));
        }
        let weekday = today.weekday().num_days_from_sunday() as i64;
        let mut closed_days: Vec<i64> = Vec::new();
        for item in &self.business_hours {
            // Python's isinstance(day, int) also accepts booleans (True == 1).
            let day = match item.get("day") {
                Some(Value::Number(n)) => match n.as_i64() {
                    Some(day) => day,
                    None => continue,
                },
                Some(Value::Bool(flag)) => i64::from(*flag),
                _ => continue,
            };
            if !(0..=6).contains(&day) {
                continue;
            }
            if item.get("closed") == Some(&Value::Bool(true)) {
                closed_days.push(day);
            } else if day == weekday {
                if let Some(opening) = item.get("open").and_then(Value::as_str) {
                    if !opening.is_empty() {
                        set(&mut context, "opening_time", take_chars(opening, 500));
                    }
                }
                if let Some(closing) = item.get("close").and_then(Value::as_str) {
                    if !closing.is_empty() {
                        set(&mut context, "closing_time", take_chars(closing, 500));
                    }
                }
            }
        }
        if !closed_days.is_empty() {
            closed_days.sort_unstable();
            closed_days.dedup();
            let days: Vec<String> = closed_days
                .iter()
                .map(|day| format!("{}曜日", WEEKDAYS[*day as usize]))
                .collect();
            set(&mut context, "closed_day", days.join("・"));
        }
        context
    }
}

fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceSettings {
    pub house: HouseSettings,
    pub shop: Option<ShopProfile>,
    pub paired: bool,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteReservation {
    pub id: String,
    pub customer_name: String,
    pub service_name: Option<String>,
    pub starts_at: DateTime<FixedOffset>,
    pub ends_at: DateTime<FixedOffset>,
    pub status: String,
    pub arrived_at: Option<String>,
}

/// `datetime.fromisoformat(value.replace("Z", "+00:00"))`, keeping only aware values.
pub fn parse_time(value: &Value) -> Option<DateTime<FixedOffset>> {
    let text = value.as_str()?.replace('Z', "+00:00");
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&text) {
        return Some(parsed);
    }
    // fromisoformat also accepts a space separator and offsets without seconds precision.
    for format in ["%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M%:z", "%Y-%m-%d %H:%M%:z"] {
        if let Ok(parsed) = DateTime::parse_from_str(&text, format) {
            return Some(parsed);
        }
    }
    None
}

pub fn parse_reservation(raw: &Value) -> Option<RemoteReservation> {
    let raw = raw.as_object()?;
    let starts_at = parse_time(raw.get("starts_at")?)?;
    let ends_at = parse_time(raw.get("ends_at")?)?;
    let id = raw.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let name = raw.get("customer_name")?.as_str()?;
    Some(RemoteReservation {
        id: id.to_string(),
        customer_name: name.to_string(),
        service_name: raw.get("service_name").and_then(Value::as_str).map(str::to_string),
        starts_at,
        ends_at,
        status: raw.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
        arrived_at: raw.get("arrived_at").and_then(Value::as_str).map(str::to_string),
    })
}

/// Calls to `/functions/v1/device/*` with the public key and a device key.
#[derive(Clone)]
pub struct DeviceApi {
    http: reqwest::Client,
    supabase_url: String,
    anon_key: String,
    house_settings_timeout: Duration,
    reservation_timeout: Duration,
}

impl DeviceApi {
    pub fn new(http: reqwest::Client, settings: &Settings) -> Self {
        Self {
            http,
            supabase_url: settings.supabase_url.clone(),
            anon_key: settings.supabase_anon_key.clone(),
            house_settings_timeout: Duration::from_secs_f64(settings.house_settings_timeout_seconds),
            reservation_timeout: Duration::from_secs_f64(settings.reservation_timeout_seconds),
        }
    }

    pub fn configured(&self) -> bool {
        !self.supabase_url.is_empty() && !self.anon_key.is_empty()
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        device_key: &str,
        timeout: Duration,
        params: &[(&str, String)],
    ) -> Result<Value, DeviceApiError> {
        if !self.configured() {
            return Err(DeviceApiError::new(None, "Supabase URL or public API key is not set"));
        }
        let url = format!("{}/functions/v1/device{path}", self.supabase_url);
        let mut request = self
            .http
            .request(method, url)
            .header("apikey", &self.anon_key)
            .header("Authorization", format!("Bearer {device_key}"))
            .timeout(timeout);
        if !params.is_empty() {
            request = request.query(params);
        }
        let response = request
            .send()
            .await
            .map_err(|error| DeviceApiError::new(None, reqwest_error_name(&error)))?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| DeviceApiError::new(None, reqwest_error_name(&error)))?;
            body.extend_from_slice(&chunk);
            if body.len() > MAX_RESPONSE_BYTES {
                return Err(DeviceApiError::new(Some(status), "response is too large"));
            }
        }
        if status >= 400 {
            return Err(DeviceApiError::new(Some(status), ""));
        }
        serde_json::from_slice(&body).map_err(|_| DeviceApiError::new(None, "JSONDecodeError"))
    }

    /// Read the device's house settings and shop once. Any failure means no settings.
    pub async fn fetch_device_settings(&self, device_key: &str) -> Option<DeviceSettings> {
        if !self.configured() {
            tracing::warn!(
                "Supabase URL or public API key is not set; using rules without house settings"
            );
            return None;
        }
        let data = match self
            .request(reqwest::Method::GET, "/settings", device_key, self.house_settings_timeout, &[])
            .await
        {
            Ok(data) => data,
            Err(error) => {
                tracing::warn!(
                    "house settings request failed: status={} error={}",
                    error.status.map_or("None".into(), |s| s.to_string()),
                    error
                );
                return None;
            }
        };
        let object = data.as_object();
        let away = object.and_then(|o| o.get("away_leave_at_door")).and_then(Value::as_bool);
        let extra = object.and_then(|o| o.get("extra_instructions")).and_then(Value::as_str);
        let (Some(away), Some(extra), Some(object)) = (away, extra, object) else {
            tracing::warn!("house settings response has an unexpected shape");
            return None;
        };
        Some(DeviceSettings {
            house: HouseSettings {
                away_leave_at_door: away,
                extra_instructions: extra.to_string(),
            },
            shop: object.get("shop").and_then(ShopProfile::from_json),
            paired: object.get("paired") != Some(&Value::Bool(false)),
            mode: object.get("mode").and_then(Value::as_str).map(str::to_string),
        })
    }

    /// Reservations overlapping `[start, end)`; cancelled ones are excluded by Supabase.
    pub async fn list_reservations<Tz: TimeZone>(
        &self,
        device_key: &str,
        start: &DateTime<Tz>,
        end: &DateTime<Tz>,
    ) -> Result<Vec<RemoteReservation>, DeviceApiError>
    where
        Tz::Offset: std::fmt::Display,
    {
        let data = self
            .request(
                reqwest::Method::GET,
                "/reservations",
                device_key,
                self.reservation_timeout,
                &[("from", py_isoformat(start)), ("to", py_isoformat(end))],
            )
            .await?;
        let Some(items) = data.get("reservations").and_then(Value::as_array) else {
            return Err(DeviceApiError::new(Some(200), "unexpected reservations response"));
        };
        Ok(items.iter().filter_map(parse_reservation).collect())
    }

    /// Record the arrival in Supabase; it notifies the shop's members. Idempotent.
    pub async fn arrive(
        &self,
        device_key: &str,
        reservation_id: &str,
    ) -> Result<RemoteReservation, DeviceApiError> {
        let path = format!("/reservations/{}/arrive", quote_path_segment(reservation_id));
        let data = self
            .request(reqwest::Method::POST, &path, device_key, self.reservation_timeout, &[])
            .await?;
        data.get("reservation")
            .and_then(parse_reservation)
            .ok_or_else(|| DeviceApiError::new(Some(200), "unexpected arrive response"))
    }
}

/// `datetime.isoformat()` for an aware value: no fraction when it is zero.
pub fn py_isoformat<Tz: TimeZone>(value: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let fixed = value.fixed_offset();
    if fixed.timestamp_subsec_micros() == 0 {
        fixed.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
    } else {
        fixed.format("%Y-%m-%dT%H:%M:%S%.6f%:z").to_string()
    }
}

/// `urllib.parse.quote(value, safe="")`.
pub fn quote_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub(crate) fn reqwest_error_name(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "TimeoutError"
    } else if error.is_connect() {
        "ClientConnectorError"
    } else if error.is_decode() || error.is_body() {
        "ClientPayloadError"
    } else {
        "ClientError"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Asia::Tokyo;
    use serde_json::json;

    #[test]
    fn shop_profile_round_trips_and_trims() {
        let raw = json!({
            "name": " ネイルサロン架空 ",
            "greeting": "いらっしゃいませ",
            "business_hours": [{"day": 1, "open": "10:00", "close": "19:00"}, "bad"],
            "services": "not a list",
        });
        let shop = ShopProfile::from_json(&raw).unwrap();
        assert_eq!(shop.name, "ネイルサロン架空");
        assert_eq!(shop.business_hours.len(), 1);
        assert!(shop.services.is_empty());
        assert_eq!(shop.to_json()["services"], json!([]));
        assert!(ShopProfile::from_json(&json!("x")).is_none());
    }

    #[test]
    fn public_context_uses_js_weekdays() {
        let shop = ShopProfile::from_json(&json!({
            "name": "店",
            "business_hours": [
                {"day": 6, "open": "10:00", "close": "18:00"},
                {"day": 0, "closed": true},
                {"day": 3, "closed": true},
                {"day": 9, "closed": true},
            ],
        }))
        .unwrap();
        // 2026-11-14 is a Saturday.
        let today = Tokyo.with_ymd_and_hms(2026, 11, 14, 12, 0, 0).unwrap();
        let context = shop.public_context(&today);
        assert_eq!(
            context,
            vec![
                ("shop_name".to_string(), "店".to_string()),
                ("opening_time".to_string(), "10:00".to_string()),
                ("closing_time".to_string(), "18:00".to_string()),
                ("closed_day".to_string(), "日曜日・水曜日".to_string()),
            ]
        );
    }

    #[test]
    fn reservations_require_aware_times() {
        let item = json!({
            "id": "r1", "customer_name": "山田", "status": "confirmed",
            "starts_at": "2026-11-14T10:00:00Z", "ends_at": "2026-11-14T11:00:00+09:00",
        });
        let parsed = parse_reservation(&item).unwrap();
        assert_eq!(parsed.starts_at.offset().local_minus_utc(), 0);
        assert!(parsed.service_name.is_none());
        let naive = json!({"id": "r1", "customer_name": "山田",
            "starts_at": "2026-11-14T10:00:00", "ends_at": "2026-11-14T11:00:00"});
        assert!(parse_reservation(&naive).is_none());
    }

    #[test]
    fn isoformat_and_quote_match_python() {
        let start = Tokyo.with_ymd_and_hms(2026, 11, 14, 0, 0, 0).unwrap();
        assert_eq!(py_isoformat(&start), "2026-11-14T00:00:00+09:00");
        assert_eq!(quote_path_segment("a/b c"), "a%2Fb%20c");
    }
}
