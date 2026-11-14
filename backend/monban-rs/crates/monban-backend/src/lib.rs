//! Monban voice reception backend (Rust port of `backend/voice-agent`, Issue #75).

pub mod app;
pub mod audio;
pub mod config;
pub mod limits;
pub mod livekit;
pub mod persistence;
pub mod reception;
pub mod relay;
pub mod services;
pub mod voice;

#[cfg(test)]
mod app_tests;
