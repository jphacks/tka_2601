//! LiveKit access tokens and the server API calls the backend makes over Twirp.
//!
//! Matches `livekit.api.AccessToken` (HS256, six-hour TTL, lowerCamel grant names) and the
//! `RoomService.ListRooms`, `RoomService.DeleteRoom` and `AgentDispatchService.CreateDispatch`
//! requests used by `core/services.py` and the v1 relay.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::Settings;

const TOKEN_TTL_SECONDS: i64 = 6 * 60 * 60;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGrants {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub room_create: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub room_list: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub room_admin: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub room_join: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub room: String,
    pub can_publish: bool,
    pub can_subscribe: bool,
    pub can_publish_data: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claims<'a> {
    iss: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    sub: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    name: &'a str,
    nbf: i64,
    exp: i64,
    video: &'a VideoGrants,
}

pub fn access_token(
    api_key: &str,
    api_secret: &str,
    identity: &str,
    name: &str,
    grants: &VideoGrants,
) -> anyhow::Result<String> {
    if grants.room_join && (identity.is_empty() || grants.room.is_empty()) {
        anyhow::bail!("identity and room must be set when joining a room");
    }
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: api_key,
        sub: identity,
        name,
        nbf: now,
        exp: now + TOKEN_TTL_SECONDS,
        video: grants,
    };
    Ok(jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(api_secret.as_bytes()),
    )?)
}

/// The visitor's token for `room` (publish and subscribe), as `/api/connect` and v1 issue it.
pub fn participant_token(settings: &Settings, room: &str, identity: &str) -> anyhow::Result<String> {
    access_token(
        &settings.livekit_api_key,
        &settings.livekit_api_secret,
        identity,
        "来訪者",
        &VideoGrants {
            room_join: true,
            room: room.to_string(),
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
            ..Default::default()
        },
    )
}

/// Twirp client for the LiveKit server API.
#[derive(Clone)]
pub struct LiveKitApi {
    http: reqwest::Client,
    url: String,
    api_key: String,
    api_secret: String,
}

impl LiveKitApi {
    pub fn new(http: reqwest::Client, settings: &Settings) -> Self {
        Self {
            http,
            url: settings.livekit_url.clone(),
            api_key: settings.livekit_api_key.clone(),
            api_secret: settings.livekit_api_secret.clone(),
        }
    }

    async fn call(
        &self,
        service: &str,
        method: &str,
        grants: VideoGrants,
        body: Value,
        timeout: Duration,
    ) -> anyhow::Result<Value> {
        let token = access_token(&self.api_key, &self.api_secret, "", "", &grants)?;
        let response = self
            .http
            .post(format!("{}/twirp/livekit.{service}/{method}", self.url))
            .bearer_auth(token)
            .json(&body)
            .timeout(timeout)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            anyhow::bail!("livekit {service}.{method} failed status={}", status.as_u16());
        }
        Ok(response.json().await?)
    }

    pub async fn list_rooms(&self) -> anyhow::Result<Value> {
        self.call(
            "RoomService",
            "ListRooms",
            VideoGrants { room_list: true, ..Default::default() },
            json!({}),
            Duration::from_secs(10),
        )
        .await
    }

    pub async fn delete_room(&self, room: &str) -> anyhow::Result<()> {
        self.call(
            "RoomService",
            "DeleteRoom",
            VideoGrants { room_create: true, ..Default::default() },
            json!({ "room": room }),
            Duration::from_secs(5),
        )
        .await
        .map(|_| ())
    }

    pub async fn create_dispatch(
        &self,
        agent_name: &str,
        room: &str,
        metadata: &str,
    ) -> anyhow::Result<()> {
        self.call(
            "AgentDispatchService",
            "CreateDispatch",
            VideoGrants { room_admin: true, room: room.to_string(), ..Default::default() },
            json!({ "agent_name": agent_name, "room": room, "metadata": metadata }),
            Duration::from_secs(10),
        )
        .await
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, DecodingKey, Validation};

    #[test]
    fn participant_token_has_livekit_claims() {
        let settings = crate::config::tests::test_settings();
        let token = participant_token(&settings, "door-abc", "visitor-1").unwrap();
        let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.validate_aud = false;
        let data = decode::<Value>(&token, &DecodingKey::from_secret(b"secret"), &validation).unwrap();
        let claims = data.claims;
        assert_eq!(claims["iss"], "devkey");
        assert_eq!(claims["sub"], "visitor-1");
        assert_eq!(claims["name"], "来訪者");
        assert_eq!(claims["video"]["roomJoin"], true);
        assert_eq!(claims["video"]["room"], "door-abc");
        assert_eq!(claims["video"]["canPublish"], true);
        assert_eq!(claims["video"]["canSubscribe"], true);
        let ttl = claims["exp"].as_i64().unwrap() - claims["nbf"].as_i64().unwrap();
        assert_eq!(ttl, TOKEN_TTL_SECONDS);
    }

    #[test]
    fn joining_requires_identity_and_room() {
        let grants = VideoGrants { room_join: true, ..Default::default() };
        assert!(access_token("k", "s", "", "", &grants).is_err());
    }
}
