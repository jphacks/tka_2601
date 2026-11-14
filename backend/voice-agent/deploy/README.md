# Monban Nginx / WAF deployment

This directory contains a reference reverse-proxy configuration for the voice
backend. Replace every `monban.example.jp` and certificate path before use.

## Layout

```text
deploy/
  nginx/
    monban.conf          # TLS termination, API/WebSocket proxy, rate limits
  waf/
    modsecurity-monban.conf
  README.md
```

## Network layout

```text
Internet
  │  HTTPS 443
  ▼
Nginx (TLS, rate limit, WAF)
  ├── /api/*            → 127.0.0.1:8093  FastAPI (API key)
  └── /api/relay        → 127.0.0.1:8093  PSoC 6 WebSocket relay

LiveKit signalling (optional separate host)
  wss://livekit.example.jp → 127.0.0.1:7880

LiveKit media
  UDP 50000-50100 (or TCP/TURN 443) directly to the LiveKit host
```

Nginx only proxies HTTP/WebSocket. WebRTC media does not go through the
`/api` proxy; open the LiveKit media ports in the host firewall and, when the
server is behind NAT, configure LiveKit's external IP or TURN.

## Required proxy headers

FastAPI checks the request scheme (HTTPS/WSS is required in production). Nginx must send:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

Start Uvicorn with:

```bash
uv run uvicorn monban_backend.api:app \
  --host 127.0.0.1 --port 8093 \
  --proxy-headers --forwarded-allow-ips=127.0.0.1
```

Only trust `127.0.0.1`. If Nginx is on another host, set
`--forwarded-allow-ips` to that exact address and restrict it with the firewall.

## Accounts and Google Calendar

Accounts, homes/shops, reservations and the Google Calendar connection are in
Supabase (Auth, Postgres and the Edge Functions `account`, `reservations`,
`calendar-sync`, `device`). This API has no login, OAuth callback or database.
The Google OAuth redirect URI is the Supabase Edge Function
`https://<project>.supabase.co/functions/v1/reservations/google/callback`.

## TLS

- TLS 1.2 and 1.3 only.
- HSTS is enabled in the reference config. Start with a short `max-age` while
  testing, then raise it.
- Keep certificates outside this repository and mount them read-only.
- If a load balancer or CDN terminates TLS, configure
  `real_ip`/`set_real_ip_from` for its address ranges and keep
  `X-Forwarded-Proto` intact.

## Logging

The reference `log_format` logs `$uri` instead of `$request_uri` so query
values do not appear in access logs. Do not add request bodies or Authorization
headers to logs.

## Rate limits

The reference config limits per client IP:

- `/api/*`: 10 requests/second, burst 30
- `/api/relay`: 10 requests/second, burst 20, 4 concurrent connections

The application also has its own per-minute and concurrency limits. Keep both:
Nginx protects the process before Python work starts, and the application
limits protect upstream models.

If clients share one NAT address, tune the zones or key them by a trusted
identifier. Do not raise limits without measuring ASR/LLM/TTS capacity.

## WAF

See `waf/README.md`. The ModSecurity/CRS file is a starting point, not a
complete security policy. Test in detection-only mode first:

```nginx
modsecurity_rules_file /etc/nginx/modsec/monban.conf;
modsecurity_rules 'SecRuleEngine DetectionOnly';
```

Then review audit logs for false positives on:

- WebSocket upgrade headers on `/api/relay`
- JSON bodies for `/api/*`

Only after tuning should `SecRuleEngine` be set to `On`.

## Health checks

The API requires a Bearer key for `/api/status`, so do not expose a public
unauthenticated health endpoint. Use a local check from the Nginx host:

```bash
curl -fsS -H "Authorization: Bearer $DOOR_API_KEY" http://127.0.0.1:8093/api/status
```

The reference config provides `/nginx-health` for an upstream load balancer.
