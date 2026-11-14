use std::net::SocketAddr;
use std::sync::Arc;

use monban_backend::app::{router, AppInner};
use monban_backend::config::Settings;
use monban_backend::services::LiveServices;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let settings = Arc::new(Settings::from_process_env()?);
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(settings.log_level.to_lowercase()));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()?;
    let services = Arc::new(LiveServices::new(settings.clone(), http.clone()));
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
