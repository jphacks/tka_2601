//! Request admission limits (port of `core/http_limits.py` and the API's request window).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// Fixed one-minute request window shared by every `/api/*` request and relay start.
pub struct RequestWindow {
    per_minute: u64,
    state: Mutex<(Instant, u64)>,
}

impl RequestWindow {
    pub fn new(per_minute: u64) -> Self {
        Self { per_minute, state: Mutex::new((Instant::now(), 0)) }
    }

    /// Take one slot; false once the current minute's budget is spent.
    pub fn take(&self) -> bool {
        let mut state = self.state.lock().expect("request window lock");
        let now = Instant::now();
        if now.duration_since(state.0) >= Duration::from_secs(60) {
            *state = (now, 0);
        }
        if state.1 >= self.per_minute {
            return false;
        }
        state.1 += 1;
        true
    }
}

/// Bound active work and the number/time of requests waiting for capacity.
pub struct CapacityLimiter {
    active_limit: usize,
    queue_limit: usize,
    wait: Duration,
    counts: Mutex<Counts>,
    released: Notify,
}

#[derive(Default)]
struct Counts {
    active: usize,
    waiting: usize,
}

/// Holds one unit of capacity; dropping it releases the unit (also on cancellation).
pub struct CapacityPermit<'a> {
    limiter: &'a CapacityLimiter,
}

impl Drop for CapacityPermit<'_> {
    fn drop(&mut self) {
        self.limiter.release();
    }
}

impl CapacityLimiter {
    pub fn new(active_limit: usize, queue_limit: usize, wait_seconds: f64) -> Self {
        Self {
            active_limit,
            queue_limit,
            wait: Duration::from_secs_f64(wait_seconds),
            counts: Mutex::new(Counts::default()),
            released: Notify::new(),
        }
    }

    pub async fn acquire(&self) -> Option<CapacityPermit<'_>> {
        {
            let mut counts = self.counts.lock().expect("capacity lock");
            if counts.active < self.active_limit {
                counts.active += 1;
                return Some(CapacityPermit { limiter: self });
            }
            if counts.waiting >= self.queue_limit {
                return None;
            }
            counts.waiting += 1;
        }
        // Decrements `waiting` however this wait ends, including cancellation.
        struct Waiting<'a>(&'a CapacityLimiter);
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.counts.lock().expect("capacity lock").waiting -= 1;
            }
        }
        let _waiting = Waiting(self);
        let deadline = tokio::time::Instant::now() + self.wait;
        loop {
            let notified = self.released.notified();
            tokio::pin!(notified);
            // Register interest before checking, so a release between the check and the
            // await still wakes this waiter.
            notified.as_mut().enable();
            {
                let mut counts = self.counts.lock().expect("capacity lock");
                if counts.active < self.active_limit {
                    counts.active += 1;
                    return Some(CapacityPermit { limiter: self });
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return None;
            }
        }
    }

    fn release(&self) {
        self.counts.lock().expect("capacity lock").active -= 1;
        self.released.notify_one();
    }

    #[cfg(test)]
    fn snapshot(&self) -> (usize, usize) {
        let counts = self.counts.lock().unwrap();
        (counts.active, counts.waiting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn capacity_limiter_bounds_queue_and_admits_after_release() {
        let limiter = Arc::new(CapacityLimiter::new(1, 1, 0.5));
        let first = limiter.acquire().await.expect("first is admitted");
        let waiter = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.acquire().await.is_some() })
        };
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(limiter.acquire().await.is_none(), "queue of one is full");
        drop(first);
        assert!(waiter.await.unwrap());
        assert_eq!(limiter.snapshot(), (0, 0));
    }

    #[tokio::test]
    async fn waiting_times_out() {
        let limiter = CapacityLimiter::new(1, 4, 0.05);
        let _held = limiter.acquire().await.unwrap();
        assert!(limiter.acquire().await.is_none());
        assert_eq!(limiter.snapshot(), (1, 0));
    }

    #[test]
    fn request_window_counts_per_minute() {
        let window = RequestWindow::new(2);
        assert!(window.take());
        assert!(window.take());
        assert!(!window.take());
    }
}
