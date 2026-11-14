# WAF notes for Monban

This is a reference setup for Nginx + ModSecurity + OWASP Core Rule Set (CRS).
It is not a drop-in security guarantee. Start in `DetectionOnly`, review audit
logs, then enforce.

## What the WAF should protect

- `/api/*`: JSON API, Bearer-authenticated. Enforce body size and reject
  protocol anomalies. Do not rely on the WAF for authentication.
- `/api/relay`: WebSocket upgrade. Allow `Upgrade`/`Connection` headers and
  disable response buffering. Do not treat WebSocket frames as HTTP bodies.
- `/` and `/healthz`: small JSON responses. The API serves no web UI.

## Recommended Nginx + ModSecurity order

```nginx
load_module modules/ngx_http_modsecurity_module.so;

http {
    modsecurity on;
    modsecurity_rules_file /etc/nginx/modsec/main.conf;
}
```

`main.conf` should include the CRS setup first, then
`monban/modsecurity-monban.conf`, so the exclusion rules can reference CRS
tags:

```nginx
Include /etc/nginx/modsec/coreruleset/crs-setup.conf
Include /etc/nginx/modsec/coreruleset/rules/*.conf
Include /etc/nginx/modsec/monban/modsecurity-monban.conf
```

## Rate limiting and body limits

Use Nginx `limit_req`/`limit_conn` (see `../nginx/monban.conf`) before
ModSecurity. Keep the API body limit at 16 KiB; the relay carries audio as
WebSocket frames, not HTTP bodies. The application also enforces request size
and concurrency limits.

## Cloudflare / managed WAF alternative

If a CDN or managed WAF terminates TLS:

- Enable managed OWASP rules and bot protection.
- Allow WebSocket upgrades on `/api/relay`.
- Keep the origin reachable only from the CDN/WAF address ranges.
- Preserve `X-Forwarded-Proto` and configure `real_ip`/`set_real_ip_from`.
- Do not cache `/api/*`.

## Things a WAF cannot fix

- A leaked `DOOR_API_KEY`
- A missing TLS certificate or an exposed origin port

Rotate `DOOR_API_KEY` and `LIVEKIT_API_SECRET` on a schedule, and keep them out of the repository and access logs.
