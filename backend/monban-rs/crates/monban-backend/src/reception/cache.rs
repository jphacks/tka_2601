//! Short-lived cache for today's reservations (port of `reception/cache.py`).
//!
//! A successful fetch is reused for `ttl`. Concurrent lookups share one in-flight request,
//! which keeps running when a caller is cancelled (Python shields it). `invalidate` drops
//! the value and prevents an older request from writing it back. Failures are never cached:
//! a failed fetch also discards the previous value, so reception cannot confirm a visit
//! from stale data.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::{BoxFuture, FutureExt, Shared};

/// A fetch failure, shared by every caller waiting on the same request.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct FetchError(pub Arc<str>);

impl FetchError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(Arc::from(message.into()))
    }
}

pub type FetchFn<T> = Arc<dyn Fn() -> BoxFuture<'static, Result<T, FetchError>> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;
type Inflight<T> = Shared<BoxFuture<'static, Result<T, FetchError>>>;

struct Entry<T> {
    key: String,
    value: T,
    expires: Instant,
}

struct State<T> {
    entry: Option<Entry<T>>,
    inflight: Option<(String, u64, Inflight<T>)>,
    generation: u64,
}

pub struct ReservationCache<T: Clone + Send + Sync + 'static> {
    state: Arc<Mutex<State<T>>>,
    fetch: FetchFn<T>,
    ttl: Duration,
    clock: Clock,
}

impl<T: Clone + Send + Sync + 'static> ReservationCache<T> {
    pub fn new(fetch: FetchFn<T>, ttl: Duration) -> Self {
        Self::with_clock(fetch, ttl, Arc::new(Instant::now))
    }

    pub fn with_clock(fetch: FetchFn<T>, ttl: Duration, clock: Clock) -> Self {
        Self {
            state: Arc::new(Mutex::new(State { entry: None, inflight: None, generation: 0 })),
            fetch,
            ttl,
            clock,
        }
    }

    fn fresh(&self, state: &State<T>, key: &str) -> Option<T> {
        let entry = state.entry.as_ref()?;
        (entry.key == key && (self.clock)() < entry.expires).then(|| entry.value.clone())
    }

    /// A fresh value without fetching.
    pub fn peek(&self, key: &str) -> Option<T> {
        let state = self.state.lock().expect("cache lock");
        self.fresh(&state, key)
    }

    pub async fn get(&self, key: &str) -> Result<T, FetchError> {
        loop {
            let (generation, task) = {
                let mut state = self.state.lock().expect("cache lock");
                if let Some(value) = self.fresh(&state, key) {
                    return Ok(value);
                }
                (state.generation, self.task_for(&mut state, key))
            };
            let value = task.await?;
            if generation == self.state.lock().expect("cache lock").generation {
                return Ok(value);
            }
            // Invalidated while the fetch was running; do not hand out stale data.
        }
    }

    /// Warm the cache without blocking on errors.
    pub async fn prefetch(&self, key: &str) {
        let task = {
            let mut state = self.state.lock().expect("cache lock");
            if self.fresh(&state, key).is_some() {
                return;
            }
            self.task_for(&mut state, key)
        };
        // The load already logged a failure; a later lookup retries.
        let _ = task.await;
    }

    /// Store a value fetched elsewhere.
    pub fn prime(&self, key: &str, value: T) {
        let mut state = self.state.lock().expect("cache lock");
        state.entry = Some(Entry { key: key.into(), value, expires: (self.clock)() + self.ttl });
    }

    pub fn invalidate(&self) {
        let mut state = self.state.lock().expect("cache lock");
        state.generation += 1;
        state.entry = None;
    }

    fn task_for(&self, state: &mut State<T>, key: &str) -> Inflight<T> {
        if let Some((inflight_key, generation, task)) = &state.inflight {
            if inflight_key == key && *generation == state.generation && task.peek().is_none() {
                return task.clone();
            }
        }
        let generation = state.generation;
        let shared_state = self.state.clone();
        let fetch = self.fetch.clone();
        let clock = self.clock.clone();
        let ttl = self.ttl;
        let owned_key = key.to_string();
        let handle = tokio::spawn(async move {
            let started = clock();
            let result = fetch().await;
            let elapsed_ms = clock().saturating_duration_since(started).as_millis();
            let mut state = shared_state.lock().expect("cache lock");
            match &result {
                Ok(value) => {
                    if generation == state.generation {
                        state.entry =
                            Some(Entry { key: owned_key, value: value.clone(), expires: clock() + ttl });
                    }
                    tracing::info!("calendar fetched duration_ms={elapsed_ms}");
                }
                Err(error) => {
                    tracing::warn!("calendar fetch failed duration_ms={elapsed_ms} error={error}");
                    if generation == state.generation {
                        state.entry = None;
                    }
                }
            }
            result
        });
        let task: Inflight<T> = async move {
            handle.await.unwrap_or_else(|error| Err(FetchError::new(format!("fetch task failed: {error}"))))
        }
        .boxed()
        .shared();
        state.inflight = Some((key.to_string(), generation, task.clone()));
        task
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    fn counting_fetch(calls: Arc<AtomicUsize>, gate: Option<Arc<Notify>>) -> FetchFn<Vec<u32>> {
        Arc::new(move || {
            let calls = calls.clone();
            let gate = gate.clone();
            async move {
                let call = calls.fetch_add(1, Ordering::SeqCst) as u32;
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                Ok(vec![call])
            }
            .boxed()
        })
    }

    #[tokio::test]
    async fn concurrent_lookups_share_one_fetch_and_reuse_it() {
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let cache = Arc::new(ReservationCache::new(
            counting_fetch(calls.clone(), Some(gate.clone())),
            Duration::from_secs(30),
        ));
        let a = tokio::spawn({ let c = cache.clone(); async move { c.get("d").await } });
        let b = tokio::spawn({ let c = cache.clone(); async move { c.get("d").await } });
        tokio::time::sleep(Duration::from_millis(10)).await;
        gate.notify_one();
        assert_eq!(a.await.unwrap().unwrap(), vec![0]);
        assert_eq!(b.await.unwrap().unwrap(), vec![0]);
        assert_eq!(cache.get("d").await.unwrap(), vec![0]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.peek("d"), Some(vec![0]));
        assert_eq!(cache.peek("other-day"), None);
    }

    #[tokio::test]
    async fn invalidate_during_fetch_refetches() {
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let cache = Arc::new(ReservationCache::new(
            counting_fetch(calls.clone(), Some(gate.clone())),
            Duration::from_secs(30),
        ));
        let waiter = tokio::spawn({ let c = cache.clone(); async move { c.get("d").await } });
        tokio::time::sleep(Duration::from_millis(10)).await;
        cache.invalidate();
        gate.notify_one();
        tokio::time::sleep(Duration::from_millis(10)).await;
        gate.notify_one();
        assert_eq!(waiter.await.unwrap().unwrap(), vec![1]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failures_are_not_cached_and_drop_the_old_value() {
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fetch: FetchFn<u32> = {
            let fail = fail.clone();
            Arc::new(move || {
                let fail = fail.load(Ordering::SeqCst);
                async move { if fail { Err(FetchError::new("down")) } else { Ok(7) } }.boxed()
            })
        };
        let now = Arc::new(Mutex::new(Instant::now()));
        let clock: Clock = { let now = now.clone(); Arc::new(move || *now.lock().unwrap()) };
        let cache = ReservationCache::with_clock(fetch, Duration::from_secs(30), clock);
        assert_eq!(cache.get("d").await.unwrap(), 7);
        *now.lock().unwrap() += Duration::from_secs(31);
        fail.store(true, Ordering::SeqCst);
        assert!(cache.get("d").await.is_err());
        assert_eq!(cache.peek("d"), None);
        cache.prefetch("d").await;
    }
}
