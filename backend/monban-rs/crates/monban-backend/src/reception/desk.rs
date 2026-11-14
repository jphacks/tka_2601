//! Reception use cases for one shop (port of `reception/service.py`).
//!
//! Reservations live in Supabase; the voice agent reads them through the device API with
//! the shop terminal's device key, so one [`ReceptionDesk`] serves one call. Without a
//! device key (an unpaired terminal) every lookup is `unavailable`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Asia::Tokyo;
use futures::FutureExt;
use serde_json::{json, Value};

use monban_policy::reception::matching::{match_reservations, normalize_name, Reservation};

use super::cache::{FetchError, FetchFn, ReservationCache};
use crate::persistence::device_api::{DeviceApi, RemoteReservation};

pub const DEFAULT_GUIDANCE: &str = "お入りになってお待ちください。";

#[derive(Debug, Clone, PartialEq)]
pub struct Confirmation {
    /// "arrived" | "already_arrived" | "needs_staff" | "unavailable"
    pub status: &'static str,
    pub reservation: Option<Reservation>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    /// "matched" | "not_found" | "ambiguous" | "unavailable" | "invalid_time"
    pub status: &'static str,
    pub reservations: Vec<Reservation>,
}

impl SearchResult {
    fn of(status: &'static str) -> Self {
        Self { status, reservations: Vec::new() }
    }
}

/// Start and end of today in Asia/Tokyo.
pub fn today_range(now: DateTime<Utc>) -> (DateTime<FixedOffset>, DateTime<FixedOffset>) {
    let today = now.with_timezone(&Tokyo).date_naive();
    let start = Tokyo
        .from_local_datetime(&today.and_time(NaiveTime::MIN))
        .single()
        .expect("Asia/Tokyo has no DST gaps")
        .fixed_offset();
    (start, start + ChronoDuration::days(1))
}

fn to_reservation(item: &RemoteReservation) -> Reservation {
    Reservation {
        event_id: item.id.clone(),
        start: item.starts_at,
        name: item.customer_name.clone(),
        kana: String::new(),
        staff: item.service_name.clone().unwrap_or_default(),
        arrived: item.arrived_at.is_some(),
    }
}

/// The source of today's reservations (the device API, or a stand-in in tests).
#[async_trait::async_trait]
pub trait ReservationSource: Send + Sync {
    async fn list(&self) -> Result<Vec<Reservation>, FetchError>;
    async fn arrive(&self, reservation_id: &str) -> Result<(), FetchError>;
}

/// Reads and records through `/functions/v1/device` with one device key.
pub struct DeviceReservations {
    pub api: DeviceApi,
    pub device_key: String,
}

#[async_trait::async_trait]
impl ReservationSource for DeviceReservations {
    async fn list(&self) -> Result<Vec<Reservation>, FetchError> {
        let (start, end) = today_range(Utc::now());
        let items = self
            .api
            .list_reservations(&self.device_key, &start, &end)
            .await
            .map_err(|error| FetchError::new(format!("DeviceApiError: {error}")))?;
        Ok(items.iter().filter(|item| item.status != "cancelled").map(to_reservation).collect())
    }

    async fn arrive(&self, reservation_id: &str) -> Result<(), FetchError> {
        self.api
            .arrive(&self.device_key, reservation_id)
            .await
            .map(|_| ())
            .map_err(|error| FetchError::new(format!("DeviceApiError: {error}")))
    }
}

pub struct ReceptionDesk {
    source: Option<Arc<dyn ReservationSource>>,
    pub cache: ReservationCache<Vec<Reservation>>,
    staff_notified: Mutex<HashMap<String, String>>,
    staff_requests: Mutex<Vec<String>>,
}

impl ReceptionDesk {
    /// `source` is `None` for an unpaired terminal.
    pub fn new(source: Option<Arc<dyn ReservationSource>>, ttl: Duration) -> Self {
        let fetch_source = source.clone();
        let fetch: FetchFn<Vec<Reservation>> = Arc::new(move || {
            let source = fetch_source.clone();
            async move {
                match source {
                    Some(source) => source.list().await,
                    None => Err(FetchError::new("DeviceApiError: device is not paired")),
                }
            }
            .boxed()
        });
        Self {
            source,
            cache: ReservationCache::new(fetch, ttl),
            staff_notified: Mutex::new(HashMap::new()),
            staff_requests: Mutex::new(Vec::new()),
        }
    }

    pub fn available(&self) -> bool {
        self.source.is_some()
    }

    /// A key that changes on a new day.
    pub fn cache_key() -> String {
        Utc::now().with_timezone(&Tokyo).date_naive().format("%Y-%m-%d").to_string()
    }

    pub async fn reservations(&self) -> Result<Vec<Reservation>, FetchError> {
        self.cache.get(&Self::cache_key()).await
    }

    /// Warm today's reservations without blocking the greeting or the first turn.
    pub async fn prefetch(&self) {
        self.cache.prefetch(&Self::cache_key()).await;
    }

    pub fn invalidate(&self) {
        self.cache.invalidate();
    }

    pub fn staff_requests(&self) -> Vec<String> {
        self.staff_requests.lock().expect("staff lock").clone()
    }

    /// Read-only lookup used by the agent's search tool.
    pub async fn search_reservations(&self, name: &str, requested_time: Option<&str>) -> SearchResult {
        let normalized = normalize_name(name);
        if normalized.is_empty() {
            return SearchResult::of("not_found");
        }
        let available = match self.reservations().await {
            Ok(available) => available,
            Err(error) => {
                tracing::warn!("reservation search failed error={error}");
                return SearchResult::of("unavailable");
            }
        };
        let matches: Vec<Reservation> = match requested_time {
            None => available
                .iter()
                .filter(|item| normalized == normalize_name(&item.name) || normalized == normalize_name(&item.kana))
                .cloned()
                .collect(),
            Some(requested_time) => {
                let Some((hour, minute)) = canonical_hh_mm(requested_time) else {
                    return SearchResult::of("invalid_time");
                };
                let now = Utc::now().with_timezone(&Tokyo);
                let requested = now
                    .with_hour(hour)
                    .and_then(|t| t.with_minute(minute))
                    .and_then(|t| t.with_second(0))
                    .and_then(|t| t.with_nanosecond(0))
                    .expect("valid wall-clock time")
                    .fixed_offset();
                match_reservations(&available, name, requested).into_iter().cloned().collect()
            }
        };
        match matches.len() {
            0 => SearchResult::of("not_found"),
            1 => SearchResult { status: "matched", reservations: matches },
            _ => SearchResult { status: "ambiguous", reservations: matches },
        }
    }

    /// Re-read the reservations before the write so a stale search cannot check in.
    pub async fn record_arrival(&self, reservation: &Reservation) -> Confirmation {
        let started = Instant::now();
        let Some(source) = self.source.clone() else {
            self.request_staff(&reservation.name);
            tracing::warn!("arrival revalidation failed error=DeviceApiError");
            return Confirmation { status: "unavailable", reservation: None };
        };
        let fresh = match source.list().await {
            Ok(fresh) => fresh,
            Err(error) => {
                self.request_staff(&reservation.name);
                tracing::warn!("arrival revalidation failed error={error}");
                return Confirmation { status: "unavailable", reservation: None };
            }
        };
        let current: Vec<&Reservation> = fresh.iter().filter(|item| item.event_id == reservation.event_id).collect();
        if current.len() != 1 {
            self.request_staff(&reservation.name);
            return Confirmation { status: "needs_staff", reservation: None };
        }
        let candidate = current[0].clone();
        let candidate_name = normalize_name(&candidate.name);
        let same_customer =
            candidate_name == normalize_name(&reservation.name) || candidate_name == normalize_name(&reservation.kana);
        if !same_customer || candidate.start != reservation.start {
            self.request_staff(&reservation.name);
            return Confirmation { status: "needs_staff", reservation: None };
        }
        if candidate.arrived {
            return Confirmation { status: "already_arrived", reservation: Some(candidate) };
        }
        if let Err(error) = source.arrive(&candidate.event_id).await {
            tracing::warn!("arrival record failed error={error}");
            return Confirmation { status: "unavailable", reservation: None };
        }
        self.cache.invalidate();
        tracing::info!("arrival recorded after revalidation duration_ms={}", started.elapsed().as_millis());
        Confirmation { status: "arrived", reservation: Some(candidate) }
    }

    /// Supabase notifies the shop's members when the arrival is recorded.
    pub fn notify_staff_recorded(&self, event_id: &str, reason: &str) -> Value {
        let mut notified = self.staff_notified.lock().expect("staff lock");
        if notified.contains_key(event_id) {
            return json!({"status": "already_recorded", "channel": "staff_reception_list"});
        }
        notified.insert(event_id.to_string(), reason.chars().take(200).collect());
        json!({"status": "recorded", "channel": "staff_reception_list"})
    }

    /// Keep the request with this call; it is saved as the visit's outcome.
    pub fn request_staff(&self, reason: &str) {
        let mut requests = self.staff_requests.lock().expect("staff lock");
        requests.push(reason.chars().take(200).collect());
        tracing::info!("staff confirmation requested count={}", requests.len());
    }

    /// Match a finalized utterance and record exactly one visit.
    pub async fn confirm(&self, name: &str, requested: DateTime<FixedOffset>) -> Confirmation {
        let reservations = match self.reservations().await {
            Ok(reservations) => reservations,
            Err(error) => {
                self.request_staff(name);
                tracing::warn!("reservation lookup failed error={error}");
                return Confirmation { status: "unavailable", reservation: None };
            }
        };
        let matches = match_reservations(&reservations, name, requested);
        if matches.len() != 1 {
            self.request_staff(name);
            return Confirmation { status: "needs_staff", reservation: None };
        }
        let only = matches[0].clone();
        self.record_arrival(&only).await
    }

    pub fn guidance() -> &'static str {
        DEFAULT_GUIDANCE
    }
}

/// `datetime.strptime(value, "%H:%M")` that also round-trips through `strftime`.
fn canonical_hh_mm(value: &str) -> Option<(u32, u32)> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || !bytes.iter().enumerate().all(|(i, b)| i == 2 || b.is_ascii_digit()) {
        return None;
    }
    let hour: u32 = value[..2].parse().ok()?;
    let minute: u32 = value[3..].parse().ok()?;
    (hour < 24 && minute < 60).then_some((hour, minute))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        rows: Mutex<Vec<Reservation>>,
        lists: AtomicUsize,
        arrivals: Mutex<Vec<String>>,
        fail_list: bool,
    }

    #[async_trait::async_trait]
    impl ReservationSource for Fake {
        async fn list(&self) -> Result<Vec<Reservation>, FetchError> {
            self.lists.fetch_add(1, Ordering::SeqCst);
            if self.fail_list {
                return Err(FetchError::new("down"));
            }
            Ok(self.rows.lock().unwrap().clone())
        }
        async fn arrive(&self, id: &str) -> Result<(), FetchError> {
            self.arrivals.lock().unwrap().push(id.into());
            for row in self.rows.lock().unwrap().iter_mut() {
                if row.event_id == id {
                    row.arrived = true;
                }
            }
            Ok(())
        }
    }

    fn today_at(hour: u32, minute: u32) -> DateTime<FixedOffset> {
        let (start, _) = today_range(Utc::now());
        start + ChronoDuration::hours(hour as i64) + ChronoDuration::minutes(minute as i64)
    }

    fn fake(rows: Vec<Reservation>, fail_list: bool) -> Arc<Fake> {
        Arc::new(Fake { rows: Mutex::new(rows), lists: AtomicUsize::new(0), arrivals: Mutex::new(vec![]), fail_list })
    }

    fn row(id: &str, name: &str, hour: u32) -> Reservation {
        Reservation {
            event_id: id.into(),
            start: today_at(hour, 0),
            name: name.into(),
            kana: String::new(),
            staff: String::new(),
            arrived: false,
        }
    }

    #[tokio::test]
    async fn search_matches_name_and_time() {
        let source = fake(vec![row("r1", "山田太郎", 15), row("r2", "山田太郎", 18)], false);
        let desk = ReceptionDesk::new(Some(source.clone()), Duration::from_secs(30));
        assert_eq!(desk.search_reservations("山田太郎", Some("15:00")).await.status, "matched");
        assert_eq!(desk.search_reservations("山田太郎", None).await.status, "ambiguous");
        assert_eq!(desk.search_reservations("山田太郎", Some("9:00")).await.status, "invalid_time");
        assert_eq!(desk.search_reservations("", None).await.status, "not_found");
        assert_eq!(desk.search_reservations("佐藤", None).await.status, "not_found");
        assert_eq!(source.lists.load(Ordering::SeqCst), 1, "today's list is cached");
    }

    #[tokio::test]
    async fn unpaired_terminal_is_unavailable() {
        let desk = ReceptionDesk::new(None, Duration::from_secs(30));
        assert!(!desk.available());
        assert_eq!(desk.search_reservations("山田", None).await.status, "unavailable");
    }

    #[tokio::test]
    async fn arrival_is_revalidated_and_recorded_once() {
        let source = fake(vec![row("r1", "山田太郎", 15)], false);
        let desk = ReceptionDesk::new(Some(source.clone()), Duration::from_secs(30));
        let found = desk.search_reservations("山田太郎", Some("15:00")).await.reservations[0].clone();
        assert_eq!(desk.record_arrival(&found).await.status, "arrived");
        assert_eq!(desk.record_arrival(&found).await.status, "already_arrived");
        assert_eq!(*source.arrivals.lock().unwrap(), vec!["r1".to_string()]);

        let mut moved = found.clone();
        moved.start = today_at(16, 0);
        assert_eq!(desk.record_arrival(&moved).await.status, "needs_staff");
        assert_eq!(desk.staff_requests(), vec!["山田太郎".to_string()]);
    }

    #[tokio::test]
    async fn lookup_failure_requests_staff() {
        let desk = ReceptionDesk::new(Some(fake(vec![], true)), Duration::from_secs(30));
        let confirmation = desk.confirm("山田", today_at(15, 0)).await;
        assert_eq!(confirmation.status, "unavailable");
        assert_eq!(desk.staff_requests().len(), 1);
    }

    #[test]
    fn staff_notifications_are_idempotent() {
        let desk = ReceptionDesk::new(None, Duration::from_secs(30));
        assert_eq!(desk.notify_staff_recorded("r1", "予約客の来店")["status"], "recorded");
        assert_eq!(desk.notify_staff_recorded("r1", "予約客の来店")["status"], "already_recorded");
    }

    #[test]
    fn hh_mm_must_be_canonical() {
        assert_eq!(canonical_hh_mm("09:05"), Some((9, 5)));
        assert_eq!(canonical_hh_mm("9:05"), None);
        assert_eq!(canonical_hh_mm("24:00"), None);
        assert_eq!(canonical_hh_mm("１２:００"), None);
    }
}
