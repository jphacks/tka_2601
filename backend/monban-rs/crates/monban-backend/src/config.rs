//! Settings built from environment variables (port of `monban_backend/config.py`).
//!
//! Defaults, validation and the production checks match the Python version. Reading goes
//! through a lookup function so tests can supply an environment without touching the
//! process environment.

use std::net::IpAddr;

use url::Url;

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub environment: Environment,
    pub api_key: String,
    pub livekit_url: String,
    pub livekit_ws_url: String,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    pub trusted_livekit_http_hosts: Vec<String>,
    pub livekit_agent_name: String,
    pub public_api_hostname: String,
    pub allowed_hosts: Vec<String>,
    pub cors_origins: Vec<String>,
    pub allow_tailnet_http: bool,

    pub ollama_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub asr_base_url: String,
    pub asr_api_key: String,
    pub asr_model: String,
    pub tts_base_url: String,
    pub tts_api_key: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_sample_rate: u32,
    pub tts_seed: u64,
    pub tts_instructions: String,
    pub house_rules: String,
    pub max_house_rules_chars: usize,
    pub max_tts_response_bytes: usize,
    pub api_requests_per_minute: u64,
    pub max_concurrent_expensive_requests: usize,
    pub max_queued_requests: usize,
    pub queue_wait_seconds: f64,
    pub max_api_request_bytes: usize,
    pub turn_detector: String,
    pub log_level: String,

    pub llm_max_tokens: u32,
    pub llm_timeout_seconds: f64,
    pub llm_keep_alive: String,
    pub warmup_enabled: bool,
    pub warmup_timeout_seconds: f64,
    pub inference_on_demand: bool,
    pub calendar_cache_seconds: f64,
    pub reservation_timeout_seconds: f64,

    pub relay_livekit_url: String,
    pub max_relay_sessions: usize,
    pub relay_start_timeout_seconds: f64,
    pub relay_log_path: String,
    pub relay_max_session_seconds: f64,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub house_settings_timeout_seconds: f64,
    pub visit_write_timeout_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Development,
    Production,
}

impl Environment {
    pub fn is_production(self) -> bool {
        self == Environment::Production
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

/// Strip trailing `/` like Python's `str.rstrip("/")`.
fn rstrip_slash(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

/// Python's `str.strip()` (Unicode whitespace).
fn py_strip(value: &str) -> &str {
    value.trim()
}

struct Env<'a> {
    lookup: &'a dyn Fn(&str) -> Option<String>,
}

impl Env<'_> {
    fn get(&self, name: &str) -> Option<String> {
        (self.lookup)(name)
    }

    fn string(&self, name: &str, default: &str) -> String {
        self.get(name).unwrap_or_else(|| default.to_string())
    }

    fn integer(&self, name: &str, default: i64) -> Result<i64, ConfigError> {
        let Some(value) = self.get(name) else {
            return Ok(default);
        };
        // Python int() accepts surrounding whitespace, an optional sign and underscores
        // between digits; accept the same common forms.
        let cleaned: String = py_strip(&value).replace('_', "");
        let parsed: i64 = cleaned
            .parse()
            .map_err(|_| ConfigError(format!("{name} must be an integer")))?;
        if parsed <= 0 {
            return err(format!("{name} must be greater than zero"));
        }
        Ok(parsed)
    }

    fn positive_float(&self, name: &str, default: f64) -> Result<f64, ConfigError> {
        let Some(value) = self.get(name) else {
            return Ok(default);
        };
        let parsed: f64 = py_strip(&value)
            .parse()
            .map_err(|_| ConfigError(format!("{name} must be a number")))?;
        // `not parsed > 0` also rejects NaN, which Python's `parsed <= 0` would accept;
        // a NaN timeout is never meaningful.
        if parsed.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return err(format!("{name} must be greater than zero"));
        }
        Ok(parsed)
    }

    fn flag(&self, name: &str, default: bool) -> bool {
        match self.get(name) {
            None => default,
            Some(value) => matches!(
                py_strip(&value).to_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            ),
        }
    }

    fn required_secret(
        &self,
        name: &str,
        development_default: Option<&str>,
        minimum_bytes: usize,
    ) -> Result<String, ConfigError> {
        let value = self
            .get(name)
            .or_else(|| development_default.map(str::to_string))
            .unwrap_or_default();
        if value.is_empty() {
            return err(format!("{name} must be set"));
        }
        if value.len() < minimum_bytes {
            return err(format!("{name} must contain at least {minimum_bytes} bytes"));
        }
        Ok(value)
    }

    fn list(&self, name: &str, default: &str) -> Vec<String> {
        self.string(name, default)
            .split(',')
            .map(|item| py_strip(item).to_string())
            .filter(|item| !item.is_empty())
            .collect()
    }
}

impl Settings {
    /// Read settings from the process environment.
    pub fn from_process_env() -> Result<Self, ConfigError> {
        Self::from_lookup(&|name| std::env::var(name).ok())
    }

    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let env = Env { lookup };
        let environment = match py_strip(&env.string("DOOR_ENV", "development"))
            .to_lowercase()
            .as_str()
        {
            "development" => Environment::Development,
            "production" => Environment::Production,
            _ => return err("DOOR_ENV must be 'development' or 'production'"),
        };
        let development = environment == Environment::Development;

        let api_key = env.required_secret("DOOR_API_KEY", None, 32)?;
        let livekit_url = rstrip_slash(&env.string("LIVEKIT_URL", "http://127.0.0.1:7880"));
        let livekit_ws_url = rstrip_slash(&env.string("LIVEKIT_WS_URL", "ws://127.0.0.1:7880"));
        let livekit_api_key =
            env.string("LIVEKIT_API_KEY", if development { "devkey" } else { "" });
        let livekit_api_secret = env.required_secret(
            "LIVEKIT_API_SECRET",
            if development { Some("secret") } else { None },
            if environment.is_production() { 32 } else { 1 },
        )?;
        let trusted_livekit_http_hosts = env
            .list("DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS", "")
            .into_iter()
            .map(|host| host.to_lowercase())
            .collect();
        let public_api_hostname = env.string("DOOR_PUBLIC_API_HOSTNAME", "localhost").to_lowercase();
        let allowed_hosts_default = format!(
            "localhost,127.0.0.1,testserver,{}",
            env.string("DOOR_PUBLIC_API_HOSTNAME", "localhost")
        );
        let allowed_hosts = env
            .list("DOOR_ALLOWED_HOSTS", &allowed_hosts_default)
            .into_iter()
            .map(|host| host.to_lowercase())
            .collect();
        let cors_origins = env
            .list("DOOR_CORS_ORIGINS", "")
            .into_iter()
            .map(|origin| rstrip_slash(&origin))
            .collect();

        let ollama_base_url = {
            let raw = rstrip_slash(&env.string("DOOR_OLLAMA_BASE_URL", "http://127.0.0.1:11434"));
            raw.strip_suffix("/v1").map(str::to_string).unwrap_or(raw)
        };

        let livekit_url_for_relay = env.string("LIVEKIT_URL", "http://127.0.0.1:7880");
        let relay_default = livekit_url_for_relay.replacen("http", "ws", 1);

        let supabase_url = rstrip_slash(
            &env.get("DOOR_SUPABASE_URL")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| env.string("SUPABASE_URL", "")),
        );
        let supabase_anon_key = env
            .get("DOOR_SUPABASE_ANON_KEY")
            .filter(|v| !v.is_empty())
            .or_else(|| env.get("SUPABASE_ANON_KEY").filter(|v| !v.is_empty()))
            .unwrap_or_else(|| env.string("SUPABASE_PUBLISHABLE_KEY", ""));
        let supabase_anon_key = py_strip(&supabase_anon_key).to_string();

        let settings = Settings {
            environment,
            api_key,
            livekit_url,
            livekit_ws_url,
            livekit_api_key,
            livekit_api_secret,
            trusted_livekit_http_hosts,
            livekit_agent_name: env.string("LIVEKIT_AGENT_NAME", "door-voice-agent"),
            public_api_hostname,
            allowed_hosts,
            cors_origins,
            allow_tailnet_http: env.flag("DOOR_ALLOW_TAILNET_HTTP", false),
            ollama_base_url,
            llm_api_key: env.string("DOOR_LLM_API_KEY", "ollama"),
            llm_model: env.string("DOOR_LLM_MODEL", "gemma4:latest"),
            asr_base_url: rstrip_slash(&env.string("DOOR_ASR_BASE_URL", "http://127.0.0.1:18095")),
            asr_api_key: env.string("DOOR_ASR_API_KEY", "local"),
            asr_model: env.string("DOOR_ASR_API_MODEL", "kotoba-tech/kotoba-whisper-v2.1"),
            tts_base_url: rstrip_slash(&env.string("DOOR_TTS_BASE_URL", "http://127.0.0.1:18094")),
            tts_api_key: env.string("DOOR_TTS_API_KEY", "local"),
            tts_model: env.string("DOOR_TTS_API_MODEL", "Irodori-TTS-v4.1-Small-MF"),
            tts_voice: env.string("DOOR_TTS_VOICE", "door_neutral"),
            tts_sample_rate: env.integer("DOOR_TTS_SAMPLE_RATE", 48000)? as u32,
            tts_seed: env.integer("DOOR_TTS_SEED", 11)? as u64,
            tts_instructions: env.string(
                "DOOR_TTS_INSTRUCTIONS",
                "落ち着いた穏やかな口調で、感情を強調せず、自然で丁寧に読み上げてください。",
            ),
            house_rules: env.string(
                "DOOR_HOUSE_RULES",
                "宅配ボックスを優先し、入らない場合は玄関前に置いてください。",
            ),
            max_house_rules_chars: env.integer("DOOR_MAX_HOUSE_RULES_CHARS", 800)? as usize,
            max_tts_response_bytes: env.integer("DOOR_MAX_TTS_RESPONSE_BYTES", 5 * 1024 * 1024)?
                as usize,
            api_requests_per_minute: env.integer("DOOR_API_REQUESTS_PER_MINUTE", 120)? as u64,
            max_concurrent_expensive_requests: env.integer("DOOR_MAX_CONCURRENT_REQUESTS", 4)?
                as usize,
            max_queued_requests: env.integer("DOOR_MAX_QUEUED_REQUESTS", 8)? as usize,
            queue_wait_seconds: env.positive_float("DOOR_QUEUE_WAIT_SECONDS", 2.0)?,
            max_api_request_bytes: env.integer("DOOR_MAX_API_REQUEST_BYTES", 16384)? as usize,
            turn_detector: env.string("DOOR_TURN_DETECTOR", "vad").to_lowercase(),
            log_level: env.string("LOG_LEVEL", "INFO").to_uppercase(),
            llm_max_tokens: env.integer("DOOR_LLM_MAX_TOKENS", 96)? as u32,
            llm_timeout_seconds: env.positive_float("DOOR_LLM_TIMEOUT_SECONDS", 30.0)?,
            llm_keep_alive: env.string("DOOR_LLM_KEEP_ALIVE", "30m"),
            warmup_enabled: env.flag("DOOR_WARMUP", true),
            warmup_timeout_seconds: env.positive_float("DOOR_WARMUP_TIMEOUT_SECONDS", 90.0)?,
            inference_on_demand: env.flag("DOOR_INFERENCE_ON_DEMAND", false),
            calendar_cache_seconds: env.positive_float("DOOR_CALENDAR_CACHE_SECONDS", 30.0)?,
            reservation_timeout_seconds: env
                .positive_float("DOOR_RESERVATION_TIMEOUT_SECONDS", 5.0)?,
            relay_livekit_url: rstrip_slash(&env.string("DOOR_RELAY_LIVEKIT_URL", &relay_default)),
            max_relay_sessions: env.integer("DOOR_MAX_RELAY_SESSIONS", 4)? as usize,
            relay_start_timeout_seconds: env
                .positive_float("DOOR_RELAY_START_TIMEOUT_SECONDS", 5.0)?,
            relay_log_path: env.string("DOOR_RELAY_LOG_PATH", ""),
            relay_max_session_seconds: env
                .positive_float("DOOR_RELAY_MAX_SESSION_SECONDS", 120.0)?,
            supabase_url,
            supabase_anon_key,
            house_settings_timeout_seconds: env
                .positive_float("DOOR_HOUSE_SETTINGS_TIMEOUT_SECONDS", 1.5)?,
            visit_write_timeout_seconds: env
                .positive_float("DOOR_VISIT_WRITE_TIMEOUT_SECONDS", 3.0)?,
        };
        settings.validate()?;
        Ok(settings)
    }

    pub fn supabase_configured(&self) -> bool {
        !self.supabase_url.is_empty() && !self.supabase_anon_key.is_empty()
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.livekit_api_key.is_empty() {
            return err("LIVEKIT_API_KEY must be set");
        }
        if !self.environment.is_production() {
            return Ok(());
        }
        if self.allowed_hosts.iter().any(|host| host.contains('*')) {
            return err("Production DOOR_ALLOWED_HOSTS must not contain '*'");
        }
        if !self.allowed_hosts.contains(&self.public_api_hostname) {
            return err("Production DOOR_ALLOWED_HOSTS must include DOOR_PUBLIC_API_HOSTNAME");
        }
        if self.livekit_api_key == "devkey" || self.livekit_api_secret == "secret" {
            return err(
                "Production requires unique LiveKit credentials; development defaults are forbidden",
            );
        }
        if self.api_key == self.livekit_api_key || self.api_key == self.livekit_api_secret {
            return err("DOOR_API_KEY must be different from LiveKit credentials");
        }

        let api_url = SplitUrl::parse(&self.livekit_url);
        let mut local_livekit_http = false;
        if api_url.scheme == "http" {
            if let Some(host) = api_url.hostname.as_deref() {
                if host == "livekit" {
                    local_livekit_http = true;
                } else if let Ok(address) = host.parse::<IpAddr>() {
                    local_livekit_http = address.is_loopback()
                        || (self.trusted_livekit_http_hosts.iter().any(|h| h == host)
                            && in_cgnat(address));
                } else {
                    local_livekit_http = host == "localhost";
                }
            }
        }
        if api_url.scheme != "https" && !local_livekit_http {
            return err(
                "Production LIVEKIT_URL must use HTTPS, loopback HTTP, or an explicitly trusted Tailscale IP",
            );
        }
        let ws_url = SplitUrl::parse(&self.livekit_ws_url);
        let trusted_tailnet_http = self.allow_tailnet_http
            && api_url.scheme == "http"
            && ws_url.scheme == "ws"
            && api_url.hostname == ws_url.hostname
            && api_url
                .hostname
                .as_deref()
                .is_some_and(|host| self.trusted_livekit_http_hosts.iter().any(|h| h == host));
        let internal_livekit_ws = api_url.hostname.as_deref() == Some("livekit")
            && ws_url.scheme == "ws"
            && ws_url.hostname.as_deref() == Some("livekit");
        if ws_url.scheme != "wss" && !(trusted_tailnet_http || internal_livekit_ws) {
            return err(
                "Production LIVEKIT_WS_URL must use WSS unless explicit trusted Tailnet HTTP is enabled",
            );
        }
        let relay_url = SplitUrl::parse(&self.relay_livekit_url);
        if relay_url.scheme != "wss"
            && !((local_livekit_http || trusted_tailnet_http)
                && relay_url.hostname == api_url.hostname)
        {
            return err(
                "Production DOOR_RELAY_LIVEKIT_URL must use WSS or the same local host as LIVEKIT_URL",
            );
        }
        if !self.supabase_url.is_empty() && SplitUrl::parse(&self.supabase_url).scheme != "https" {
            return err("Production DOOR_SUPABASE_URL must use HTTPS");
        }
        Ok(())
    }
}

fn in_cgnat(address: IpAddr) -> bool {
    match address {
        // 100.64.0.0/10
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            octets[0] == 100 && (octets[1] & 0b1100_0000) == 64
        }
        IpAddr::V6(_) => false,
    }
}

/// The parts of `urllib.parse.urlsplit` the production checks use: the lowercased scheme
/// and the lowercased hostname (without brackets or port).
struct SplitUrl {
    scheme: String,
    hostname: Option<String>,
}

impl SplitUrl {
    fn parse(value: &str) -> Self {
        if let Ok(url) = Url::parse(value) {
            let hostname = url.host_str().map(|host| {
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_lowercase()
            });
            return SplitUrl {
                scheme: url.scheme().to_lowercase(),
                hostname: hostname.filter(|h| !h.is_empty()),
            };
        }
        // urlsplit never fails; an unparsable value has no usable scheme or host.
        SplitUrl {
            scheme: value
                .split_once(':')
                .map(|(scheme, _)| scheme.to_lowercase())
                .unwrap_or_default(),
            hostname: None,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    pub(crate) const TEST_API_KEY: &str = "test-api-key-with-at-least-32-bytes!!";

    pub(crate) fn settings_with(pairs: &[(&str, &str)]) -> Result<Settings, ConfigError> {
        let mut map: HashMap<String, String> = HashMap::new();
        map.insert("DOOR_API_KEY".into(), TEST_API_KEY.into());
        for (key, value) in pairs {
            map.insert((*key).into(), (*value).into());
        }
        Settings::from_lookup(&move |name| map.get(name).cloned())
    }

    pub(crate) fn test_settings() -> Settings {
        settings_with(&[]).expect("development defaults are valid")
    }

    fn production(extra: &[(&str, &str)]) -> Result<Settings, ConfigError> {
        let mut pairs = vec![
            ("DOOR_ENV", "production"),
            ("LIVEKIT_API_KEY", "prod-livekit-key"),
            ("LIVEKIT_API_SECRET", "prod-livekit-secret-with-32-bytes-minimum"),
            ("DOOR_PUBLIC_API_HOSTNAME", "monban.example.com"),
            ("LIVEKIT_URL", "http://livekit:7880"),
            ("LIVEKIT_WS_URL", "ws://livekit:7880"),
        ];
        pairs.extend_from_slice(extra);
        settings_with(&pairs)
    }

    #[test]
    fn development_defaults_match_python() {
        let s = test_settings();
        assert_eq!(s.livekit_api_key, "devkey");
        assert_eq!(s.livekit_api_secret, "secret");
        assert_eq!(s.allowed_hosts, ["localhost", "127.0.0.1", "testserver", "localhost"]);
        assert_eq!(s.ollama_base_url, "http://127.0.0.1:11434");
        assert_eq!(s.relay_livekit_url, "ws://127.0.0.1:7880");
        assert_eq!(s.tts_sample_rate, 48000);
        assert_eq!(s.max_api_request_bytes, 16384);
        assert!(s.warmup_enabled);
        assert!(!s.supabase_configured());
    }

    #[test]
    fn api_key_must_be_long() {
        let mut map = HashMap::new();
        map.insert("DOOR_API_KEY".to_string(), "short".to_string());
        let error = Settings::from_lookup(&move |n| map.get(n).cloned()).unwrap_err();
        assert_eq!(error.0, "DOOR_API_KEY must contain at least 32 bytes");
    }

    #[test]
    fn ollama_v1_suffix_is_removed() {
        let s = settings_with(&[("DOOR_OLLAMA_BASE_URL", "https://llm.example/v1/")]).unwrap();
        assert_eq!(s.ollama_base_url, "https://llm.example");
    }

    #[test]
    fn integers_must_be_positive() {
        let error = settings_with(&[("DOOR_MAX_RELAY_SESSIONS", "0")]).unwrap_err();
        assert_eq!(error.0, "DOOR_MAX_RELAY_SESSIONS must be greater than zero");
        let error = settings_with(&[("DOOR_MAX_RELAY_SESSIONS", "x")]).unwrap_err();
        assert_eq!(error.0, "DOOR_MAX_RELAY_SESSIONS must be an integer");
    }

    #[test]
    fn supabase_key_falls_back_like_python() {
        let s = settings_with(&[
            ("SUPABASE_URL", "https://p.supabase.co/"),
            ("SUPABASE_PUBLISHABLE_KEY", " sb_publishable_x "),
        ])
        .unwrap();
        assert_eq!(s.supabase_url, "https://p.supabase.co");
        assert_eq!(s.supabase_anon_key, "sb_publishable_x");
        assert!(s.supabase_configured());
    }

    #[test]
    fn production_accepts_internal_livekit() {
        production(&[]).expect("compose-internal LiveKit is allowed");
    }

    #[test]
    fn production_rejects_development_credentials() {
        let error = settings_with(&[
            ("DOOR_ENV", "production"),
            ("LIVEKIT_API_KEY", "devkey"),
            ("LIVEKIT_API_SECRET", "prod-livekit-secret-with-32-bytes-minimum"),
            ("DOOR_PUBLIC_API_HOSTNAME", "localhost"),
        ])
        .unwrap_err();
        assert!(error.0.starts_with("Production requires unique LiveKit credentials"));
    }

    #[test]
    fn production_requires_public_host_in_allowed_hosts() {
        let error = production(&[("DOOR_ALLOWED_HOSTS", "localhost")]).unwrap_err();
        assert_eq!(error.0, "Production DOOR_ALLOWED_HOSTS must include DOOR_PUBLIC_API_HOSTNAME");
        let error = production(&[("DOOR_ALLOWED_HOSTS", "*,monban.example.com")]).unwrap_err();
        assert_eq!(error.0, "Production DOOR_ALLOWED_HOSTS must not contain '*'");
    }

    #[test]
    fn production_rejects_remote_plain_http_livekit() {
        let error = production(&[("LIVEKIT_URL", "http://10.0.0.5:7880")]).unwrap_err();
        assert!(error.0.starts_with("Production LIVEKIT_URL must use HTTPS"));
    }

    #[test]
    fn production_trusted_tailnet_http() {
        let base = [
            ("LIVEKIT_URL", "http://100.101.102.103:7880"),
            ("LIVEKIT_WS_URL", "ws://100.101.102.103:7880"),
            ("DOOR_LIVEKIT_TRUSTED_HTTP_HOSTS", "100.101.102.103"),
        ];
        let error = production(&base).unwrap_err();
        assert!(error.0.starts_with("Production LIVEKIT_WS_URL must use WSS"));
        let mut allowed = base.to_vec();
        allowed.push(("DOOR_ALLOW_TAILNET_HTTP", "1"));
        production(&allowed).expect("explicit trusted Tailnet HTTP is allowed");
    }

    #[test]
    fn production_supabase_must_be_https() {
        let error = production(&[("DOOR_SUPABASE_URL", "http://p.supabase.co")]).unwrap_err();
        assert_eq!(error.0, "Production DOOR_SUPABASE_URL must use HTTPS");
    }
}
