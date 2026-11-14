// Google カレンダーの接続（OAuth、カレンダーの選択、解除）
import { type CalendarStore, clientForConnection, type GoogleConfig } from "../_shared/calendar_store.ts";
import { GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL } from "../_shared/google_calendar.ts";
import { ProviderError } from "../_shared/reservation.ts";
import { decryptToken, encryptToken } from "../_shared/token_crypto.ts";
import { type CompletingMember, holdTokens, takeTokens } from "./oauth_pending.ts";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "openid",
  "email",
];
const APP_SCHEME = "tka2601://";
export const STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleDeps = { store: CalendarStore; config: GoogleConfig | null; fetch?: typeof fetch; now?: () => Date };

function requireConfig(config: GoogleConfig | null): GoogleConfig {
  if (!config) throw new ProviderError(503, "Google カレンダーの接続が設定されていません", "google_not_configured");
  return config;
}

// 転送先はアプリに限る（オープンリダイレクトを防ぐ）
export function isAllowedReturnUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(APP_SCHEME) && !/[\s\\]/.test(url);
}

function callbackUrl(config: GoogleConfig): string {
  return `${config.publicUrl}/google/callback`;
}

export async function startOAuth(deps: GoogleDeps, householdId: string, userId: string, returnUrl: unknown): Promise<string> {
  const config = requireConfig(deps.config);
  if (!isAllowedReturnUrl(returnUrl)) throw new ProviderError(400, "return_url が正しくありません");
  const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  await deps.store.saveState({ state, household_id: householdId, user_id: userId, return_url: returnUrl, provider: "google_calendar" });
  return `${GOOGLE_AUTH_URL}?${new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(config),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  })}`;
}

function appRedirect(returnUrl: string, result: string): Response {
  const separator = returnUrl.includes("?") ? "&" : "?";
  return new Response(null, { status: 302, headers: { Location: `${returnUrl}${separator}google=${result}` } });
}

type HeldGoogleTokens = { refresh_token: string; account_email: string | null };

// Google が呼ぶ。JWT はなく、使い切りの state で確かめる。トークンは保留にして、接続にはしない
export async function handleCallback(deps: GoogleDeps, url: URL): Promise<Response> {
  const config = requireConfig(deps.config);
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const saved = await deps.store.takeState(url.searchParams.get("state") ?? "");
  if (!saved || saved.provider !== "google_calendar" || now.getTime() - Date.parse(saved.created_at) > STATE_TTL_MS) {
    return Response.json({ error: "接続の手続きが無効です。アプリからやり直してください" }, { status: 400 });
  }
  const code = url.searchParams.get("code");
  if (!code) return appRedirect(saved.return_url, "cancelled");

  try {
    const tokenRes = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUrl(config),
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokens?.refresh_token || !tokens?.access_token) {
      console.error("Google token exchange failed", tokenRes.status, tokens?.error);
      return appRedirect(saved.return_url, "error");
    }
    const infoRes = await doFetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const email = infoRes.ok ? ((await infoRes.json().catch(() => null))?.email as string | undefined) ?? null : null;

    const held: HeldGoogleTokens = { refresh_token: tokens.refresh_token, account_email: email };
    const pendingCode = await holdTokens(deps.store, config.tokenKey, "google_calendar", saved, held);
    return appRedirect(saved.return_url, `pending&code=${pendingCode}`);
  } catch (e) {
    console.error("Google OAuth failed", e);
    return appRedirect(saved.return_url, "error");
  }
}

// アプリが JWT 付きで呼ぶ。始めた本人だと確かめてから接続にする
export async function completeOAuth(deps: GoogleDeps, member: CompletingMember, code: unknown): Promise<void> {
  const config = requireConfig(deps.config);
  const held = await takeTokens<HeldGoogleTokens>(
    deps.store,
    config.tokenKey,
    "google_calendar",
    code,
    member,
    deps.now?.() ?? new Date(),
  );
  // 同じアカウントで接続し直したときは、選んだカレンダーと差分の起点を残す
  const previous = await deps.store.getConnection(member.householdId);
  const sameAccount = previous !== null && previous.account_email === held.account_email;
  // 別のアカウントではカレンダーを選び直すことになる。選ぶまでは Google を予約先にできないので、
  // 予約先が Google のままなら予約帳に戻す（残すと読み書きがすべて 409 になる）。接続を書く前に戻す
  if (previous !== null && !sameAccount && await deps.store.getProviderKind(member.householdId) === "google_calendar") {
    await deps.store.setProviderKind(member.householdId, "monban");
  }
  await deps.store.saveConnection({
    household_id: member.householdId,
    account_email: held.account_email,
    calendar_id: sameAccount ? previous.calendar_id : null,
    calendar_name: sameAccount ? previous.calendar_name : null,
    sync_token: sameAccount ? previous.sync_token : null,
    refresh_token_encrypted: await encryptToken(held.refresh_token, config.tokenKey),
    status: "active",
    last_error: null,
    connected_by: member.userId,
  });
}

async function requireClient(deps: GoogleDeps, householdId: string) {
  const config = requireConfig(deps.config);
  const connection = await deps.store.getConnection(householdId);
  if (!connection) throw new ProviderError(409, "Google カレンダーの接続が済んでいません", "google_not_connected");
  return { connection, client: await clientForConnection(connection, config, deps.fetch ?? fetch) };
}

export async function listCalendars(deps: GoogleDeps, householdId: string) {
  const { client } = await requireClient(deps, householdId);
  return await client.listCalendars();
}

// 選んだカレンダーの差分の起点を取り直す。それまでの予定は通知しない
export async function selectCalendar(deps: GoogleDeps, householdId: string, calendarId: unknown) {
  if (typeof calendarId !== "string" || calendarId === "") throw new ProviderError(400, "calendar_id を入れてください");
  const { client } = await requireClient(deps, householdId);
  const calendar = (await client.listCalendars()).find((c) => c.id === calendarId);
  if (!calendar) throw new ProviderError(404, "カレンダーが見つかりません");
  const syncToken = await client.baseline(calendarId, (deps.now?.() ?? new Date()).toISOString());
  await deps.store.updateConnection(householdId, {
    calendar_id: calendarId,
    calendar_name: calendar.name,
    sync_token: syncToken,
    status: "active",
    last_error: null,
  });
}

// 接続を消し、予約先を予約帳に戻す。Google への取り消しは失敗しても続ける
export async function disconnect(deps: GoogleDeps, householdId: string): Promise<void> {
  const connection = await deps.store.getConnection(householdId);
  if (connection && deps.config) {
    try {
      const token = await decryptToken(connection.refresh_token_encrypted, deps.config.tokenKey);
      await (deps.fetch ?? fetch)(`${GOOGLE_REVOKE_URL}?${new URLSearchParams({ token })}`, { method: "POST" });
    } catch (e) {
      console.warn("Google の連携を取り消せませんでした", e);
    }
  }
  await deps.store.deleteConnection(householdId);
  if (await deps.store.getProviderKind(householdId) === "google_calendar") {
    await deps.store.setProviderKind(householdId, "monban");
  }
}

export async function providerStatus(store: CalendarStore, householdId: string) {
  const [provider, connection, square] = await Promise.all([
    store.getProviderKind(householdId),
    store.getConnection(householdId),
    store.getSquareConnection(householdId),
  ]);
  return {
    provider,
    // Square はアプリから予約を足せない（読み取りだけ）
    capabilities: { create: provider !== "square" },
    google: {
      connected: connection !== null,
      account_email: connection?.account_email ?? null,
      calendar_id: connection?.calendar_id ?? null,
      calendar_name: connection?.calendar_name ?? null,
      status: connection?.status ?? null,
      last_error: connection?.last_error ?? null,
    },
    square: {
      connected: square !== null,
      merchant_name: square?.merchant_name ?? null,
      status: square?.status ?? null,
      last_error: square?.last_error ?? null,
    },
  };
}
