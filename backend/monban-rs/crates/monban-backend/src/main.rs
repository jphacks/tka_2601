use std::net::SocketAddr;
use std::sync::Arc;

use monban_backend::app::{router, AppInner};
use monban_backend::config::Settings;
use monban_backend::services::LiveServices;
use monban_backend::voice::adapters::live_models;
use monban_backend::voice::runtime::DeviceRuntimeFactory;

/// `monban-api healthcheck`: exit 0 when the local server answers /healthz (the image has
/// no Python or curl for the compose healthcheck).
async fn healthcheck() -> anyhow::Result<()> {
    let port = std::env::var("MONBAN_PORT").unwrap_or_else(|_| "8093".into());
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/healthz"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await?;
    anyhow::ensure!(response.status().is_success(), "healthz answered {}", response.status());
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck().await;
    }
    let settings = Arc::new(Settings::from_process_env()?);
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(settings.log_level.to_lowercase()));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()?;
    let services = Arc::new(LiveServices::new(settings.clone(), http.clone()));
    // Relay v2 runs the voice pipeline in this process.
    let models = Arc::new(live_models(settings.clone(), http.clone()));
    monban_backend::relay::set_runtime_factory(Arc::new(DeviceRuntimeFactory { models }));
    let state = Arc::new(AppInner::new(settings, http, services));

    let host = std::env::var("MONBAN_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("MONBAN_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8093);
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!("listening on {address}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
