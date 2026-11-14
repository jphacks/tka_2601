//! Errors from the model clients, classified the way livekit-agents classifies them
//! (`APITimeoutError`, `APIStatusError`, `APIConnectionError`, `APIError`).

use std::time::Duration;

/// Which upstream failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Asr,
    Llm,
    Tts,
}

impl std::fmt::Display for Service {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Service::Asr => "ASR",
            Service::Llm => "LLM",
            Service::Tts => "TTS",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClientError {
    /// `APITimeoutError`: connecting, sending or a read took too long.
    #[error("{service} request timed out")]
    Timeout { service: Service },
    /// `APIStatusError`: the upstream answered with a non-success status.
    #[error("{service} returned HTTP {status}")]
    Status { service: Service, status: u16 },
    /// `APIConnectionError`: the request or the response stream failed.
    #[error("{service} connection failed: {detail}")]
    Connection { service: Service, detail: String },
    /// `APIError`: the upstream answered with something unusable.
    #[error("{service}: {detail}")]
    Protocol { service: Service, detail: String, retryable: bool },
}

impl ClientError {
    pub fn service(&self) -> Service {
        match self {
            ClientError::Timeout { service }
            | ClientError::Status { service, .. }
            | ClientError::Connection { service, .. }
            | ClientError::Protocol { service, .. } => *service,
        }
    }

    /// livekit-agents' `APIError.retryable`. 4xx statuses other than 408, 429 and 499 are
    /// never retried (`APIStatusError.__init__`).
    pub fn retryable(&self) -> bool {
        match self {
            ClientError::Timeout { .. } | ClientError::Connection { .. } => true,
            ClientError::Status { status, .. } => {
                !(400..500).contains(status) || matches!(status, 408 | 429 | 499)
            }
            ClientError::Protocol { retryable, .. } => *retryable,
        }
    }

    pub(crate) fn from_reqwest(service: Service, error: reqwest::Error) -> Self {
        if error.is_timeout() {
            ClientError::Timeout { service }
        } else {
            ClientError::Connection { service, detail: error.to_string() }
        }
    }

    pub(crate) fn protocol(service: Service, detail: impl Into<String>) -> Self {
        ClientError::Protocol { service, detail: detail.into(), retryable: true }
    }
}

/// livekit-agents' `APIConnectOptions._interval_for_retry`: the first retry waits 0.1 s
/// whatever `retry_interval` says, later ones wait `retry_interval`.
pub(crate) fn livekit_retry_interval(attempt: usize, retry_interval: Duration) -> Duration {
    if attempt == 0 {
        Duration::from_millis(100)
    } else {
        retry_interval
    }
}
