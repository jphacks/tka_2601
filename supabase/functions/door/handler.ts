// アプリからボイスバックエンド（backend/voice-agent）の受付 API と Google カレンダー連携 API を呼ぶ中継。
// DOOR_API_KEY はグループ全員で共有する秘密なので、アプリには渡さずここで付ける。
// 受け付けるのは、許可したグループ（DOOR_ALLOWED_HOUSEHOLD_IDS）の人だけ
import { readJsonObject } from "../_shared/errors.ts";
import { ProviderError } from "../_shared/reservation.ts";
import type { Member } from "../_shared/member_auth.ts";

export type DoorConfig = {
  // 末尾の / は付けない。本番は https
  baseUrl: string;
  apiKey: string;
  allowedHouseholdIds: string[];
};

export type DoorDeps = {
  // null は未ログイン、"forbidden" はグループに入っていない
  authenticate(req: Request): Promise<Member | "forbidden" | null>;
  config: DoorConfig | null;
  fetch?: typeof fetch;
};

type Route = { method: string; upstream: string; body?: (body: Record<string, unknown>) => Record<string, unknown> };

// ボイスバックエンドの OpenAPI（v1.1.0）にある、アプリから使うものだけ
const ROUTES: Record<string, Route> = {
  "GET /status": { method: "GET", upstream: "/api/status" },
  "GET /reception/settings": { method: "GET", upstream: "/api/reception/settings" },
  "PUT /reception/settings": { method: "PUT", upstream: "/api/reception/settings", body: parseGuidance },
  "GET /reception/visits": { method: "GET", upstream: "/api/reception/visits" },
  "GET /google-calendar/status": { method: "GET", upstream: "/api/integrations/google-calendar/status" },
  "POST /google-calendar/start": { method: "POST", upstream: "/api/integrations/google-calendar/start" },
  "POST /google-calendar/disconnect": { method: "POST", upstream: "/api/integrations/google-calendar/disconnect" },
  "GET /google-calendar/calendars": { method: "GET", upstream: "/api/integrations/google-calendar/calendars" },
  "POST /google-calendar/select": { method: "POST", upstream: "/api/integrations/google-calendar/select", body: parseSelection },
  "GET /google-calendar/events": { method: "GET", upstream: "/api/integrations/google-calendar/events" },
};

const UPSTREAM_TIMEOUT_MS = 10_000;

export function doorConfigFromEnv(env: (name: string) => string | undefined = (name) => Deno.env.get(name)): DoorConfig | null {
  const baseUrl = env("DOOR_API_BASE_URL")?.trim().replace(/\/+$/, "");
  const apiKey = env("DOOR_API_KEY")?.trim();
  const allowedHouseholdIds = (env("DOOR_ALLOWED_HOUSEHOLD_IDS") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!baseUrl || !apiKey || allowedHouseholdIds.length === 0) return null;
  return { baseUrl, apiKey, allowedHouseholdIds };
}

// Guidance: 1〜300 字
function parseGuidance(body: Record<string, unknown>): Record<string, unknown> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 1 || text.length > 300) throw new ProviderError(400, "案内文は 1 字以上 300 字以内にしてください");
  return { text };
}

// Selection: calendar_id は 1〜1024 字
function parseSelection(body: Record<string, unknown>): Record<string, unknown> {
  const calendarId = body.calendar_id;
  if (typeof calendarId !== "string" || calendarId.length < 1 || calendarId.length > 1024) {
    throw new ProviderError(400, "calendar_id を指定してください");
  }
  return { calendar_id: calendarId };
}

export async function handleDoorRequest(req: Request, deps: DoorDeps): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/^(?:\/functions\/v1)?\/door/, "").replace(/\/$/, "");
  const route = ROUTES[`${req.method} ${path}`];
  if (!route) {
    const knownPath = Object.keys(ROUTES).some((key) => key.slice(key.indexOf(" ") + 1) === path);
    return Response.json({ error: knownPath ? "method not allowed" : "not found" }, { status: knownPath ? 405 : 404 });
  }

  try {
    const member = await deps.authenticate(req);
    if (member === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (member === "forbidden") return Response.json({ error: "グループに入っていません" }, { status: 403 });
    if (!deps.config) {
      return Response.json({ error: "受付の接続先が設定されていません", code: "door_not_configured" }, { status: 503 });
    }
    if (!deps.config.allowedHouseholdIds.includes(member.householdId)) {
      return Response.json({ error: "このグループでは受付の設定を使えません" }, { status: 403 });
    }

    const body = route.body ? route.body(await readJsonObject(req)) : undefined;
    return await callUpstream(deps.config, deps.fetch ?? fetch, route, body);
  } catch (e) {
    if (e instanceof ProviderError) {
      return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
    }
    throw e;
  }
}

async function callUpstream(
  config: DoorConfig,
  doFetch: typeof fetch,
  route: Route,
  body: Record<string, unknown> | undefined,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await doFetch(`${config.baseUrl}${route.upstream}`, {
      method: route.method,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("door backend unreachable", e instanceof Error ? e.name : e);
    return Response.json({ error: "受付に接続できません", code: "door_unavailable" }, { status: 502 });
  }

  if (upstream.ok) {
    const payload = await upstream.json().catch(() => null);
    if (payload === null) return Response.json({ error: "受付の返事を読めません", code: "door_unavailable" }, { status: 502 });
    return Response.json(payload);
  }

  // 鍵が通らないのはこちらの設定の誤り。アプリに 401 を返すとログアウトと見分けられない
  if (upstream.status === 401) {
    console.error("door backend rejected the api key");
    return Response.json({ error: "受付に接続できません", code: "door_unauthorized" }, { status: 502 });
  }
  const detail = await upstream.json().then((j) => (typeof j?.detail === "string" ? j.detail : null)).catch(() => null);
  const status = [400, 404, 413, 422, 429, 503].includes(upstream.status) ? upstream.status : 502;
  return Response.json(
    { error: detail ?? "受付で処理できませんでした", code: status === 503 ? "door_unavailable" : "door_rejected" },
    { status },
  );
}
