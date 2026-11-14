//! The HTTP API (port of `api.py`, `legal.py` and the API middleware).
//!
//! Middleware runs in the same order as the FastAPI app, outermost first:
//! `protect_api` (HTTP only), CORS, TrustedHost, then the request body limit.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use http_body_util::BodyExt;
use rand::RngCore;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use monban_policy::house_rules::{build_house_rules, Mode};

use crate::config::Settings;
use crate::limits::{CapacityLimiter, RequestWindow};
use crate::persistence::device_api::{DeviceApi, DeviceSettings};
use crate::persistence::history::VisitHistory;
use crate::services::{HttpError, Services};

const PREVIEW_THANKS: &str = "ありがとうございます。";
const PREVIEW_COMPOUND: &str = "ありがとうございます。それでは、お荷物は玄関前にお願いいたします。";
/// Production exposes only the status check; voice uses the WSS `/api/relay`. The direct
/// WebRTC `/api/connect` answers 409 there so a misconfigured client gets a clear reason.
const PRODUCTION_API: [(&str, &str); 2] = [("GET", "/api/status"), ("POST", "/api/connect")];
const CAPACITY_PATHS: [&str; 3] = ["/api/status", "/api/connect", "/api/tts-check"];

pub struct AppInner {
    pub settings: Arc<Settings>,
    pub http: reqwest::Client,
    pub services: Arc<dyn Services>,
    pub device_api: DeviceApi,
    pub history: VisitHistory,
    pub requests: RequestWindow,
    pub capacity: CapacityLimiter,
    pub relay_sessions: AtomicUsize,
}

pub type AppState = Arc<AppInner>;

impl AppInner {
    pub fn new(settings: Arc<Settings>, http: reqwest::Client, services: Arc<dyn Services>) -> Self {
        Self {
            device_api: DeviceApi::new(http.clone(), &settings),
            history: VisitHistory::new(http.clone(), &settings),
            requests: RequestWindow::new(settings.api_requests_per_minute),
            capacity: CapacityLimiter::new(
                settings.max_concurrent_expensive_requests,
                settings.max_queued_requests,
                settings.queue_wait_seconds,
            ),
            relay_sessions: AtomicUsize::new(0),
            settings,
            http,
            services,
        }
    }

    /// `secrets.compare_digest` of the Bearer key, as `_valid_api_key`.
    pub fn valid_api_key(&self, authorization: &str) -> bool {
        let Some((scheme, supplied)) = authorization.split_once(' ') else { return false };
        scheme.eq_ignore_ascii_case("bearer")
            && bool::from(supplied.trim().as_bytes().ct_eq(self.settings.api_key.as_bytes()))
    }
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/", get(root))
        .route("/about", get(|| legal(LEGAL_ABOUT)))
        .route("/privacy", get(|| legal(LEGAL_PRIVACY)))
        .route("/terms", get(|| legal(LEGAL_TERMS)))
        .route("/openapi.json", get(openapi))
        .route("/docs", get(|| html(DOCS_HTML)))
        .route("/redoc", get(|| html(REDOC_HTML)))
        .route("/api/status", get(status))
        .route("/api/connect", post(connect))
        .route("/api/tts-check", post(tts_check))
        .route("/api/relay", get(relay_websocket))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn_with_state(state.clone(), body_limit))
        .layer(middleware::from_fn_with_state(state.clone(), trusted_host));
    if !state.settings.cors_origins.is_empty() {
        app = app.layer(cors_layer(&state.settings));
    }
    app.layer(middleware::from_fn_with_state(state.clone(), protect_api)).with_state(state)
}

fn cors_layer(settings: &Settings) -> tower_http::cors::CorsLayer {
    use tower_http::cors::{AllowOrigin, CorsLayer};
    let origins: Vec<HeaderValue> =
        settings.cors_origins.iter().filter_map(|origin| origin.parse().ok()).collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

// ---------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------

/// A body-only response without a media type, like Starlette's `Response(content)`.
fn plain(status: StatusCode, body: &'static str, headers: &[(HeaderName, &'static str)]) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    for (name, value) in headers {
        response.headers_mut().insert(name.clone(), HeaderValue::from_static(value));
    }
    response
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = Response::new(Body::from(serde_json::to_vec(&value).expect("json")));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn detail(status: u16, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        json!({ "detail": message }),
    )
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        detail(self.status, &self.detail)
    }
}

/// FastAPI's 422 body for one invalid field.
fn validation_error(kind: &str, loc: &[&str], msg: &str, input: Value) -> Response {
    json_response(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({ "detail": [{ "type": kind, "loc": loc, "msg": msg, "input": input }] }),
    )
}

async fn not_found() -> Response {
    detail(404, "Not Found")
}

async fn method_not_allowed() -> Response {
    detail(405, "Method Not Allowed")
}

// ---------------------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------------------

/// The request scheme as uvicorn derives it with `--proxy-headers --forwarded-allow-ips *`.
pub fn request_scheme(headers: &HeaderMap, websocket: bool) -> String {
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string());
    match (forwarded, websocket) {
        (Some(proto), true) => if proto == "https" || proto == "wss" { "wss" } else { "ws" }.into(),
        (Some(proto), false) => proto,
        (None, true) => "ws".into(),
        (None, false) => "http".into(),
    }
}

fn is_websocket(request: &Request) -> bool {
    request
        .headers()
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

async fn protect_api(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // BaseHTTPMiddleware does not see WebSocket connections.
    if is_websocket(&request) {
        return next.run(request).await;
    }
    let settings = &state.settings;
    let path = request.uri().path().to_string();
    let is_api = path.starts_with("/api/");
    if is_api {
        let scheme = request_scheme(request.headers(), false);
        if settings.environment.is_production() && scheme != "https" && !settings.allow_tailnet_http {
            return plain(StatusCode::BAD_REQUEST, "HTTPS is required", &[]);
        }
        if !state.requests.take() {
            return plain(
                StatusCode::TOO_MANY_REQUESTS,
                "Too Many Requests",
                &[(header::RETRY_AFTER, "60"), (header::CACHE_CONTROL, "no-store")],
            );
        }
        let method = request.method().as_str();
        if settings.environment.is_production()
            && !PRODUCTION_API.iter().any(|(m, p)| *m == method && *p == path)
        {
            return plain(StatusCode::NOT_FOUND, "", &[(header::CACHE_CONTROL, "no-store")]);
        }
        let authorization = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !state.valid_api_key(authorization) {
            return plain(
                StatusCode::UNAUTHORIZED,
                "Unauthorized",
                &[(header::WWW_AUTHENTICATE, "Bearer"), (header::CACHE_CONTROL, "no-store")],
            );
        }
        if let Some(length) = request.headers().get(header::CONTENT_LENGTH) {
            match length.to_str().ok().and_then(|value| value.trim().parse::<u64>().ok()) {
                Some(length) if length > settings.max_api_request_bytes as u64 => {
                    return plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large", &[]);
                }
                Some(_) => {}
                None => return plain(StatusCode::BAD_REQUEST, "Invalid Content-Length", &[]),
            }
        }
    }

    let mut response = if CAPACITY_PATHS.contains(&path.as_str()) {
        let Some(_permit) = state.capacity.acquire().await else {
            return plain(
                StatusCode::SERVICE_UNAVAILABLE,
                "Service is at capacity; retry shortly",
                &[(header::RETRY_AFTER, "1"), (header::CACHE_CONTROL, "no-store")],
            );
        };
        next.run(request).await
    } else {
        next.run(request).await
    };
    if is_api {
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    }
    response
}

/// Starlette's TrustedHostMiddleware with `www_redirect=True`.
async fn trusted_host(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let allowed = &state.settings.allowed_hosts;
    if allowed.iter().any(|pattern| pattern == "*") {
        return next.run(request).await;
    }
    let host_header = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let host = host_header.split(':').next().unwrap_or("");
    let matches = |host: &str| {
        allowed.iter().any(|pattern| {
            pattern == host || (pattern.starts_with('*') && host.ends_with(&pattern[1..]))
        })
    };
    if matches(host) {
        return next.run(request).await;
    }
    let www = format!("www.{host}");
    if allowed.contains(&www) {
        let scheme = request_scheme(request.headers(), false);
        let path_and_query = request.uri().path_and_query().map_or("/", |pq| pq.as_str());
        let port = host_header.split_once(':').map(|(_, port)| format!(":{port}")).unwrap_or_default();
        let location = format!("{scheme}://www.{host}{port}{path_and_query}");
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::TEMPORARY_REDIRECT;
        if let Ok(value) = HeaderValue::from_str(&location) {
            response.headers_mut().insert(header::LOCATION, value);
        }
        return response;
    }
    let mut response = plain(StatusCode::BAD_REQUEST, "Invalid host header", &[]);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

/// Bound `/api/*` request bodies, including chunked bodies without Content-Length.
async fn body_limit(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if is_websocket(&request) || !request.uri().path().starts_with("/api/") {
        return next.run(request).await;
    }
    let limit = state.settings.max_api_request_bytes;
    let too_large = || plain(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large", &[]);
    if let Some(length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
    {
        if length > limit as u64 {
            return too_large();
        }
    }
    let (parts, body) = request.into_parts();
    let mut body = body;
    let mut buffered: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { break };
        if let Ok(data) = frame.into_data() {
            if buffered.len() + data.len() > limit {
                return too_large();
            }
            buffered.extend_from_slice(&data);
        }
    }
    next.run(Request::from_parts(parts, Body::from(buffered))).await
}

// ---------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------

async fn healthz() -> Response {
    json_response(StatusCode::OK, json!({ "status": "ok" }))
}

async fn root() -> Response {
    json_response(StatusCode::OK, json!({ "service": "monban-api", "docs": "/docs", "health": "/healthz" }))
}

const LEGAL_ABOUT: &str = include_str!("../assets/legal/about.html");
const LEGAL_PRIVACY: &str = include_str!("../assets/legal/privacy.html");
const LEGAL_TERMS: &str = include_str!("../assets/legal/terms.html");
const OPENAPI_JSON: &str = include_str!("../assets/openapi/openapi.json");
const DOCS_HTML: &str = include_str!("../assets/openapi/docs.html");
const REDOC_HTML: &str = include_str!("../assets/openapi/redoc.html");

async fn legal(page: &'static str) -> Response {
    let mut response = html(page).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

async fn html(page: &'static str) -> Response {
    let mut response = Response::new(Body::from(page));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    response
}

async fn openapi() -> Response {
    let mut response = Response::new(Body::from(OPENAPI_JSON));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

async fn status(State(state): State<AppState>) -> Response {
    let settings = &state.settings;
    let services = &state.services;
    let (asr_ready, tts_ready, llm_ready) = if settings.inference_on_demand {
        (None, None, None)
    } else {
        let (asr, tts, llm) = tokio::join!(
            services.model_available(&settings.asr_base_url, &settings.asr_model, None, &settings.asr_api_key),
            services.model_available(
                &settings.tts_base_url,
                &settings.tts_model,
                Some(&settings.tts_voice),
                &settings.tts_api_key
            ),
            services.llm_available(),
        );
        (Some(asr), Some(tts), Some(llm))
    };
    let livekit_ready = services.livekit_available().await;
    let on_demand_configured = [
        &settings.ollama_base_url,
        &settings.llm_api_key,
        &settings.asr_base_url,
        &settings.asr_api_key,
        &settings.tts_base_url,
        &settings.tts_api_key,
    ]
    .iter()
    .all(|value| !value.is_empty());
    let ready = livekit_ready
        && if settings.inference_on_demand {
            on_demand_configured
        } else {
            tts_ready == Some(true) && asr_ready == Some(true) && llm_ready == Some(true)
        };
    json_response(
        StatusCode::OK,
        json!({
            "livekit": { "ready": livekit_ready },
            "asr": { "model": settings.asr_model, "ready": asr_ready },
            "tts": { "model": settings.tts_model, "voice": settings.tts_voice, "ready": tts_ready },
            "llm": { "model": settings.llm_model, "ready": llm_ready },
            "inference_mode": if settings.inference_on_demand { "on-demand" } else { "always-on" },
            "ready": ready,
            "supabase_configured": settings.supabase_configured(),
        }),
    )
}

pub fn token_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    hex::encode(buffer)
}

/// Shop devices get the reception agent; homes and unpaired devices get the door agent.
pub fn reception_metadata(device_key: Option<&str>, device: Option<&DeviceSettings>) -> Option<Value> {
    let (device_key, shop) = (device_key?, device?.shop.as_ref()?);
    Some(json!({ "device_key": device_key, "shop": shop.to_json() }))
}

/// The validated `/api/connect` body.
#[derive(Debug, Default)]
struct ConnectRequest {
    house_rules: Option<String>,
    device_key: Option<String>,
    mode: Option<Mode>,
}

#[allow(clippy::result_large_err)] // the error is the finished 422 response
fn parse_connect_body(body: &[u8], max_house_rules_chars: usize) -> Result<Option<ConnectRequest>, Response> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(body).map_err(|error| {
        validation_error("json_invalid", &["body", "0"], "JSON decode error", json!({ "error": error.to_string() }))
    })?;
    let object = match value {
        Value::Null => return Ok(None),
        Value::Object(object) => object,
        other => {
            return Err(validation_error(
                "model_attributes_type",
                &["body"],
                "Input should be a valid dictionary or object to extract fields from",
                other,
            ))
        }
    };
    let mut request = ConnectRequest::default();
    match object.get("house_rules") {
        None | Some(Value::Null) => {}
        Some(Value::String(rules)) => {
            if rules.chars().count() > max_house_rules_chars {
                return Err(validation_error(
                    "string_too_long",
                    &["body", "house_rules"],
                    &format!("String should have at most {max_house_rules_chars} characters"),
                    Value::String(rules.clone()),
                ));
            }
            request.house_rules = Some(rules.clone());
        }
        Some(other) => {
            return Err(validation_error("string_type", &["body", "house_rules"], "Input should be a valid string", other.clone()))
        }
    }
    match object.get("device_key") {
        None | Some(Value::Null) => {}
        Some(Value::String(key)) => {
            let length = key.chars().count();
            if length == 0 {
                return Err(validation_error("string_too_short", &["body", "device_key"], "String should have at least 1 character", key.clone().into()));
            }
            if length > 512 {
                return Err(validation_error("string_too_long", &["body", "device_key"], "String should have at most 512 characters", key.clone().into()));
            }
            if !key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
                return Err(validation_error(
                    "string_pattern_mismatch",
                    &["body", "device_key"],
                    "String should match pattern '^[\\x21-\\x7e]+$'",
                    key.clone().into(),
                ));
            }
            request.device_key = Some(key.clone());
        }
        Some(other) => {
            return Err(validation_error("string_type", &["body", "device_key"], "Input should be a valid string", other.clone()))
        }
    }
    match object.get("mode") {
        None => {}
        Some(value) => match value.as_str().and_then(Mode::parse) {
            Some(mode) => request.mode = Some(mode),
            None => {
                return Err(validation_error(
                    "literal_error",
                    &["body", "mode"],
                    "Input should be 'normal', 'omakase' or 'away'",
                    value.clone(),
                ))
            }
        },
    }
    Ok(Some(request))
}

async fn connect(State(state): State<AppState>, body: Bytes) -> Response {
    let settings = &state.settings;
    if settings.environment.is_production() {
        return detail(
            409,
            "一般インターネットの音声はWSS /api/relayを使用してください。直接WebRTCは公開していません。",
        );
    }
    let request = match parse_connect_body(&body, settings.max_house_rules_chars) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let room = format!("door-{}", token_hex(5));
    let identity = format!("visitor-{}", token_hex(4));
    let mut reception = None;
    let house_rules = match &request {
        Some(ConnectRequest { device_key: Some(device_key), mode, .. }) => {
            let Some(device) = state.services.fetch_device_settings(device_key).await else {
                return detail(502, "Supabaseから端末の設定を取得できません。");
            };
            reception = reception_metadata(Some(device_key), Some(&device));
            build_house_rules(mode.unwrap_or_default(), Some(&device.house), settings.max_house_rules_chars)
        }
        Some(ConnectRequest { house_rules: Some(rules), .. }) => rules.trim().to_string(),
        _ => settings.house_rules.clone(),
    };
    if house_rules.chars().count() > settings.max_house_rules_chars {
        return detail(422, "住人ルールが長すぎます。");
    }
    let token = match crate::livekit::participant_token(settings, &room, &identity) {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!("token creation failed: {error}");
            return detail(500, "Internal Server Error");
        }
    };
    if let Err(error) = state.services.dispatch_agent(&room, &house_rules, reception).await {
        tracing::warn!("agent dispatch failed: {error}");
        return detail(503, "音声エージェントを開始できません。");
    }
    json_response(StatusCode::OK, json!({ "url": settings.livekit_ws_url, "token": token, "room": room }))
}

#[derive(serde::Deserialize)]
struct TtsCheckQuery {
    scenario: Option<String>,
}

async fn tts_check(State(state): State<AppState>, Query(query): Query<TtsCheckQuery>) -> Response {
    let text = match query.scenario.as_deref() {
        None | Some("thanks") => PREVIEW_THANKS,
        Some("compound") => PREVIEW_COMPOUND,
        Some(other) => {
            return validation_error(
                "literal_error",
                &["query", "scenario"],
                "Input should be 'thanks' or 'compound'",
                other.into(),
            )
        }
    };
    match state.services.synthesize_preview(text).await {
        Ok(wav) => {
            let mut response = Response::new(Body::from(wav));
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/wav"));
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            response
        }
        Err(error) => error.into_response(),
    }
}

/// Bridge PCM audio over WSS for devices that cannot use direct WebRTC.
async fn relay_websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let scheme = request_scheme(&headers, true);
    tracing::info!("relay websocket request secure={}", scheme == "wss");
    let settings = &state.settings;
    let authorization = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
    let insecure = settings.environment.is_production() && scheme != "wss" && !settings.allow_tailnet_http;
    if insecure || !state.valid_api_key(authorization) {
        // Closing before accept makes Starlette answer the handshake with 403.
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade.on_upgrade(move |socket| async move {
        let mut socket = socket;
        let busy = !state.requests.take()
            || state.relay_sessions.load(Ordering::SeqCst) >= state.settings.max_relay_sessions;
        if busy {
            crate::relay::reject_busy(&mut socket).await;
            return;
        }
        state.relay_sessions.fetch_add(1, Ordering::SeqCst);
        struct Session(AppState);
        impl Drop for Session {
            fn drop(&mut self) {
                self.0.relay_sessions.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let session = Session(state.clone());
        crate::relay::serve(state, socket).await;
        drop(session);
    })
}
