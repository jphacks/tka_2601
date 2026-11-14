//! Port of `tests/test_api.py` (Issue #76).

use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use monban_policy::house_rules::HouseSettings;

use crate::app::{router, AppInner};
use crate::config::tests::{settings_with, TEST_API_KEY};
use crate::config::Settings;
use crate::persistence::device_api::{DeviceSettings, ShopProfile};
use crate::services::{HttpError, Services};

#[derive(Default)]
struct Fake {
    models_ready: bool,
    livekit_ready: bool,
    probe_models_panics: bool,
    dispatch_fails: bool,
    dispatched: Mutex<Vec<(String, String, Option<Value>)>>,
    devices: Vec<(String, DeviceSettings)>,
    preview: Option<Result<Vec<u8>, HttpError>>,
}

#[async_trait::async_trait]
impl Services for Fake {
    async fn model_available(&self, _: &str, _: &str, _: Option<&str>, _: &str) -> bool {
        assert!(!self.probe_models_panics, "status must not wake on-demand inference");
        self.models_ready
    }
    async fn llm_available(&self) -> bool {
        assert!(!self.probe_models_panics, "status must not wake on-demand inference");
        self.models_ready
    }
    async fn livekit_available(&self) -> bool {
        self.livekit_ready
    }
    async fn dispatch_agent(&self, room: &str, rules: &str, reception: Option<Value>) -> anyhow::Result<()> {
        if self.dispatch_fails {
            anyhow::bail!("agent worker is unavailable");
        }
        self.dispatched.lock().unwrap().push((room.into(), rules.into(), reception));
        Ok(())
    }
    async fn fetch_device_settings(&self, key: &str) -> Option<DeviceSettings> {
        self.devices.iter().find(|(k, _)| k == key).map(|(_, d)| d.clone())
    }
    async fn synthesize_preview(&self, _text: &str) -> Result<Vec<u8>, HttpError> {
        self.preview.clone().unwrap_or_else(|| panic!("unauthenticated request reached TTS"))
    }
}

fn app_with(settings: Settings, fake: Arc<Fake>) -> axum::Router {
    let state = Arc::new(AppInner::new(Arc::new(settings), reqwest::Client::new(), fake));
    router(state)
}

fn dev() -> Settings {
    settings_with(&[]).unwrap()
}

fn production_tailnet() -> Settings {
    settings_with(&[
        ("DOOR_ENV", "production"),
        ("DOOR_ALLOW_TAILNET_HTTP", "1"),
        ("LIVEKIT_API_KEY", "prod-livekit-key"),
        ("LIVEKIT_API_SECRET", "prod-livekit-secret-with-32-bytes-minimum"),
        ("LIVEKIT_URL", "http://livekit:7880"),
        ("LIVEKIT_WS_URL", "ws://livekit:7880"),
        ("DOOR_ALLOWED_HOSTS", "testserver,localhost"),
        ("DOOR_PUBLIC_API_HOSTNAME", "testserver"),
    ])
    .unwrap()
}

fn request(method: &str, path: &str, auth: bool, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path).header(header::HOST, "testserver");
    if auth {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {TEST_API_KEY}"));
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, body)
}

fn json_body(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap()
}

#[tokio::test]
async fn status_reports_individual_service_readiness() {
    let fake = Arc::new(Fake { models_ready: true, livekit_ready: false, ..Default::default() });
    let (status, headers, body) = send(&app_with(dev(), fake), request("GET", "/api/status", true, None)).await;
    assert_eq!(status, StatusCode::OK);
    let result = json_body(&body);
    assert_eq!(result["asr"]["ready"], true);
    assert_eq!(result["tts"]["ready"], true);
    assert_eq!(result["llm"]["ready"], true);
    assert_eq!(result["livekit"]["ready"], false);
    assert_eq!(result["ready"], false);
    assert!(result.get("supabase_configured").is_some());
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[tokio::test]
async fn on_demand_status_does_not_wake_modal_models() {
    let settings = settings_with(&[("DOOR_INFERENCE_ON_DEMAND", "1")]).unwrap();
    let fake = Arc::new(Fake { probe_models_panics: true, livekit_ready: true, ..Default::default() });
    let (_, _, body) = send(&app_with(settings, fake), request("GET", "/api/status", true, None)).await;
    let result = json_body(&body);
    assert_eq!(result["inference_mode"], "on-demand");
    assert_eq!(result["asr"]["ready"], Value::Null);
    assert_eq!(result["tts"]["ready"], Value::Null);
    assert_eq!(result["llm"]["ready"], Value::Null);
    assert_eq!(result["ready"], true);
}

#[tokio::test]
async fn root_returns_api_metadata_without_serving_a_web_ui() {
    let app = app_with(dev(), Arc::new(Fake::default()));
    let (status, _, body) = send(&app, request("GET", "/", false, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_body(&body), json!({"service": "monban-api", "docs": "/docs", "health": "/healthz"}));
    let (status, _, body) = send(&app, request("GET", "/assets/app.js", false, None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json_body(&body), json!({"detail": "Not Found"}));
}

#[tokio::test]
async fn production_preserves_authenticated_voice_api_endpoints() {
    let app = app_with(production_tailnet(), Arc::new(Fake::default()));
    let (unauthorized, _, _) = send(&app, request("POST", "/api/connect", false, Some(json!({})))).await;
    let (direct, _, body) = send(&app, request("POST", "/api/connect", true, Some(json!({})))).await;
    let (tts, _, _) = send(&app, request("POST", "/api/tts-check", true, None)).await;
    assert_eq!(unauthorized, StatusCode::UNAUTHORIZED);
    assert_eq!(direct, StatusCode::CONFLICT);
    assert!(json_body(&body)["detail"].as_str().unwrap().contains("/api/relay"));
    assert_eq!(tts, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn production_requires_https_without_tailnet_http() {
    let mut settings = production_tailnet();
    settings.allow_tailnet_http = false;
    let app = app_with(settings, Arc::new(Fake::default()));
    let (status, _, body) = send(&app, request("GET", "/api/status", true, None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, b"HTTPS is required");
    let mut forwarded = request("GET", "/api/status", true, None);
    forwarded.headers_mut().insert("x-forwarded-proto", "https".parse().unwrap());
    let (status, _, _) = send(&app, forwarded).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn demo_account_and_google_routes_are_gone() {
    let app = app_with(dev(), Arc::new(Fake::default()));
    for (method, path) in [
        ("GET", "/api/control/mode"),
        ("PUT", "/api/control/mode"),
        ("GET", "/api/control/sessions"),
        ("POST", "/api/test/rules"),
        ("POST", "/api/test/visits"),
        ("POST", "/api/demo/connect"),
        ("POST", "/api/demo/speech"),
        ("POST", "/api/reception/connect"),
        ("GET", "/api/reception/settings"),
        ("POST", "/api/integrations/google-calendar/start"),
        ("POST", "/api/v1/auth/login"),
        ("GET", "/oauth/google/callback"),
        ("GET", "/env-config.js"),
    ] {
        let (status, _, _) = send(&app, request(method, path, true, Some(json!({})))).await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED,
            "{method} {path} answered {status}"
        );
    }
}

#[tokio::test]
async fn connect_returns_503_when_dispatch_fails() {
    let fake = Arc::new(Fake { dispatch_fails: true, ..Default::default() });
    let body = json!({"house_rules": "宅配ボックスへお願いします。"});
    let (status, _, body) = send(&app_with(dev(), fake), request("POST", "/api/connect", true, Some(body))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(&body), json!({"detail": "音声エージェントを開始できません。"}));
}

#[tokio::test]
async fn connect_uses_the_device_settings_from_supabase() {
    let shop = ShopProfile { name: "ネイルサロン架空".into(), ..Default::default() };
    let fake = Arc::new(Fake {
        devices: vec![
            (
                "home-key".into(),
                DeviceSettings {
                    house: HouseSettings {
                        extra_instructions: "呼び鈴を鳴らしたら少し待ってください。".into(),
                        ..Default::default()
                    },
                    shop: None,
                    paired: true,
                    mode: None,
                },
            ),
            (
                "shop-key".into(),
                DeviceSettings { house: HouseSettings::default(), shop: Some(shop.clone()), paired: true, mode: None },
            ),
        ],
        ..Default::default()
    });
    let app = app_with(dev(), fake.clone());
    let (status, _, body) =
        send(&app, request("POST", "/api/connect", true, Some(json!({"device_key": "home-key", "mode": "away"})))).await;
    assert_eq!(status, StatusCode::OK);
    let home = json_body(&body);
    {
        let dispatched = fake.dispatched.lock().unwrap();
        assert_eq!(home["room"], dispatched[0].0);
        assert!(dispatched[0].1.contains("不在票を入れるよう頼む"));
        assert!(dispatched[0].1.contains("呼び鈴を鳴らしたら少し待ってください。"));
        assert!(dispatched[0].2.is_none());
    }
    assert_eq!(home["url"], "ws://127.0.0.1:7880");
    assert!(home["room"].as_str().unwrap().starts_with("door-"));
    assert_eq!(home["room"].as_str().unwrap().len(), "door-".len() + 10);

    send(&app, request("POST", "/api/connect", true, Some(json!({"device_key": "shop-key"})))).await;
    assert_eq!(
        fake.dispatched.lock().unwrap()[1].2,
        Some(json!({"device_key": "shop-key", "shop": shop.to_json()}))
    );

    let (status, _, body) =
        send(&app, request("POST", "/api/connect", true, Some(json!({"device_key": "unknown-key"})))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json_body(&body), json!({"detail": "Supabaseから端末の設定を取得できません。"}));
}

#[tokio::test]
async fn connect_validates_its_body() {
    let app = app_with(dev(), Arc::new(Fake::default()));
    for body in [
        json!({"mode": "vacation"}),
        json!({"device_key": ""}),
        json!({"device_key": "has space"}),
        json!({"house_rules": "あ".repeat(801)}),
        json!([1]),
    ] {
        let (status, _, response) = send(&app, request("POST", "/api/connect", true, Some(body.clone()))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert!(json_body(&response)["detail"].is_array());
    }
    // An empty body falls back to the configured house rules.
    let (status, _, _) = send(&app, request("POST", "/api/connect", true, None)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn tts_preview_is_playable_wav() {
    let wav = crate::audio::wav_mono16(&[0; 960], 48000);
    let fake = Arc::new(Fake { preview: Some(Ok(wav)), ..Default::default() });
    let (status, headers, body) =
        send(&app_with(dev(), fake), request("POST", "/api/tts-check?scenario=thanks", true, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "audio/wav");
    assert_eq!(&body[..4], b"RIFF");
}

#[tokio::test]
async fn tts_preview_rejects_unknown_scenarios() {
    let fake = Arc::new(Fake { preview: Some(Ok(vec![])), ..Default::default() });
    let (status, _, _) =
        send(&app_with(dev(), fake), request("POST", "/api/tts-check?scenario=other", true, None)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn tts_preview_reports_upstream_errors() {
    let fake = Arc::new(Fake {
        preview: Some(Err(HttpError::new(502, "音声モデルの応答が上限を超えました。"))),
        ..Default::default()
    });
    let (status, _, body) =
        send(&app_with(dev(), fake), request("POST", "/api/tts-check?scenario=thanks", true, None)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json_body(&body), json!({"detail": "音声モデルの応答が上限を超えました。"}));
}

#[tokio::test]
async fn api_routes_reject_missing_or_invalid_keys() {
    let app = app_with(dev(), Arc::new(Fake::default()));
    let (missing, headers, _) = send(&app, request("GET", "/api/status", false, None)).await;
    assert_eq!(missing, StatusCode::UNAUTHORIZED);
    assert_eq!(headers[header::WWW_AUTHENTICATE], "Bearer");
    let invalid = Request::builder()
        .method("POST")
        .uri("/api/connect")
        .header(header::HOST, "testserver")
        .header(header::AUTHORIZATION, "Bearer invalid")
        .body(Body::from(r#"{"house_rules":"hello"}"#))
        .unwrap();
    let (status, _, _) = send(&app, invalid).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(&app, request("POST", "/api/tts-check?scenario=thanks", false, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn request_body_limit_rejects_chunked_body_without_content_length() {
    let settings = settings_with(&[("DOOR_MAX_API_REQUEST_BYTES", "4")]).unwrap();
    let app = app_with(settings, Arc::new(Fake::default()));
    let chunks = futures::stream::iter(vec![
        Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"1234")),
        Ok(bytes::Bytes::from_static(b"5")),
    ]);
    let request = Request::builder()
        .method("POST")
        .uri("/api/connect")
        .header(header::HOST, "testserver")
        .header(header::AUTHORIZATION, format!("Bearer {TEST_API_KEY}"))
        .body(Body::from_stream(chunks))
        .unwrap();
    let (status, _, body) = send(&app, request).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body, b"Request body is too large");
}

#[tokio::test]
async fn untrusted_host_is_rejected_after_authentication() {
    let app = app_with(dev(), Arc::new(Fake::default()));
    let mut unauthenticated = request("GET", "/api/status", false, None);
    unauthenticated.headers_mut().insert(header::HOST, "evil.example".parse().unwrap());
    let (status, _, _) = send(&app, unauthenticated).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "protect_api runs before TrustedHost");
    let mut authenticated = request("GET", "/healthz", false, None);
    authenticated.headers_mut().insert(header::HOST, "evil.example".parse().unwrap());
    let (status, _, body) = send(&app, authenticated).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, b"Invalid host header");
}

#[tokio::test]
async fn public_pages_for_the_google_consent_screen() {
    let app = app_with(production_tailnet(), Arc::new(Fake::default()));
    for (path, heading) in [
        ("/about", "<h1>Monban</h1>"),
        ("/privacy", "<h1>プライバシーポリシー</h1>"),
        ("/terms", "<h1>利用規約</h1>"),
    ] {
        let (status, headers, body) = send(&app, request("GET", path, false, None)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/html"));
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains(heading));
        assert!(!text.contains("<script"));
        assert!(headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("frame-ancestors 'none'"));
        if path == "/privacy" {
            assert!(text.contains("限定使用"));
            assert!(text.contains("calendar.events"));
        }
    }
    let (_, _, body) = send(&app, request("GET", "/openapi.json", false, None)).await;
    let paths = json_body(&body)["paths"].as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert!(!paths.iter().any(|p| p == "/about" || p == "/privacy" || p == "/terms"));
}

#[tokio::test]
async fn rate_limit_answers_429() {
    let settings = settings_with(&[("DOOR_API_REQUESTS_PER_MINUTE", "1")]).unwrap();
    let app = app_with(settings, Arc::new(Fake { models_ready: true, livekit_ready: true, ..Default::default() }));
    let (first, _, _) = send(&app, request("GET", "/api/status", true, None)).await;
    let (second, headers, _) = send(&app, request("GET", "/api/status", true, None)).await;
    assert_eq!(first, StatusCode::OK);
    assert_eq!(second, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers[header::RETRY_AFTER], "60");
}
