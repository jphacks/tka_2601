// Square の接続（OAuth、解除）と Webhook
import type { CalendarStore } from "../_shared/calendar_store.ts";
import type { NewNotification } from "../_shared/notify.ts";
import { ProviderError } from "../_shared/reservation.ts";
import { reservationNotice } from "../_shared/reservation_notice.ts";
import {
  bookingToReservation,
  classifyBookingEvent,
  hasValidSquareSignature,
  resolveBookings,
  type SquareBooking,
  SquareClient,
  type SquareConfig,
  type SquareConnection,
  squareDedupeKey,
  SQUARE_SCOPES,
} from "../_shared/square.ts";
import { encryptToken } from "../_shared/token_crypto.ts";
import { isAllowedReturnUrl, STATE_TTL_MS } from "./google.ts";
import { type CompletingMember, holdTokens, takeTokens } from "./oauth_pending.ts";

export type SquareDeps = {
  store: CalendarStore;
  squareConfig?: SquareConfig | null;
  squareClient?: (connection: SquareConnection, config: SquareConfig) => Pick<SquareClient, "customers" | "serviceNames">;
  notify(notification: NewNotification): Promise<void>;
  // Webhook で使う。失敗を投げて Square に送り直してもらう
  notifyOrThrow(notification: NewNotification): Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
};

function requireConfig(config: SquareConfig | null | undefined): SquareConfig {
  if (!config) throw new ProviderError(503, "Square の接続が設定されていません", "square_not_configured");
  return config;
}

export async function startSquareOAuth(deps: SquareDeps, householdId: string, userId: string, returnUrl: unknown): Promise<string> {
  const config = requireConfig(deps.squareConfig);
  if (!isAllowedReturnUrl(returnUrl)) throw new ProviderError(400, "return_url が正しくありません");
  const state = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  await deps.store.saveState({ state, household_id: householdId, user_id: userId, return_url: returnUrl, provider: "square" });
  return `${config.baseUrl}/oauth2/authorize?${new URLSearchParams({
    client_id: config.applicationId,
    scope: SQUARE_SCOPES.join(" "),
    session: "false",
    state,
  })}`;
}

function appRedirect(returnUrl: string, result: string): Response {
  const separator = returnUrl.includes("?") ? "&" : "?";
  return new Response(null, { status: 302, headers: { Location: `${returnUrl}${separator}square=${result}` } });
}

type HeldSquareTokens = {
  access_token: string;
  refresh_token: string;
  merchant_id: string;
  merchant_name: string | null;
  expires_at: string;
};

// Square が呼ぶ。JWT はなく、使い切りの state で確かめる。トークンは保留にして、接続にはしない
export async function handleSquareCallback(deps: SquareDeps, url: URL): Promise<Response> {
  const config = requireConfig(deps.squareConfig);
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const saved = await deps.store.takeState(url.searchParams.get("state") ?? "");
  if (!saved || saved.provider !== "square" || now.getTime() - Date.parse(saved.created_at) > STATE_TTL_MS) {
    return Response.json({ error: "接続の手続きが無効です。アプリからやり直してください" }, { status: 400 });
  }
  const code = url.searchParams.get("code");
  if (!code) return appRedirect(saved.return_url, "cancelled");

  try {
    const tokenRes = await doFetch(`${config.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.applicationId,
        client_secret: config.applicationSecret,
        code,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokens?.access_token || !tokens?.refresh_token || !tokens?.merchant_id || !tokens?.expires_at) {
      console.error("Square token exchange failed", tokenRes.status, tokens?.errors?.[0]?.code);
      return appRedirect(saved.return_url, "error");
    }
    const merchantRes = await doFetch(`${config.baseUrl}/v2/merchants/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
    });
    const merchant = merchantRes.ok ? await merchantRes.json().catch(() => null) : null;

    const held: HeldSquareTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      merchant_id: tokens.merchant_id,
      merchant_name: merchant?.merchant?.business_name ?? null,
      expires_at: tokens.expires_at,
    };
    const pendingCode = await holdTokens(deps.store, config.tokenKey, "square", saved, held);
    return appRedirect(saved.return_url, `pending&code=${pendingCode}`);
  } catch (e) {
    console.error("Square OAuth failed", e);
    return appRedirect(saved.return_url, "error");
  }
}

// アプリが JWT 付きで呼ぶ。始めた本人だと確かめてから接続にする
export async function completeSquareOAuth(deps: SquareDeps, member: CompletingMember, code: unknown): Promise<void> {
  const config = requireConfig(deps.squareConfig);
  const held = await takeTokens<HeldSquareTokens>(deps.store, config.tokenKey, "square", code, member, deps.now?.() ?? new Date());
  // 1つの Square のアカウントは1つの店にだけ結び付ける
  const other = await deps.store.squareConnectionByMerchant(held.merchant_id);
  if (other && other.household_id !== member.householdId) {
    throw new ProviderError(409, "この Square のアカウントは別の店で使われています", "square_merchant_in_use");
  }
  const connection = {
    household_id: member.householdId,
    merchant_id: held.merchant_id,
    merchant_name: held.merchant_name,
    access_token_encrypted: await encryptToken(held.access_token, config.tokenKey),
    refresh_token_encrypted: await encryptToken(held.refresh_token, config.tokenKey),
    access_token_expires_at: held.expires_at,
    status: "active" as const,
    last_error: null,
    connected_by: member.userId,
  };
  try {
    await deps.store.saveSquareConnection(connection);
  } catch (e) {
    // 確かめてから書くまでに別の店が同じ Square を結び付けると、merchant_id の一意制約（23505）で落ちる
    if ((e as { code?: unknown } | null)?.code === "23505") {
      throw new ProviderError(409, "この Square のアカウントは別の店で使われています", "square_merchant_in_use");
    }
    throw e;
  }
}

// 接続を消し、予約先を予約帳に戻す。Square への取り消しは失敗しても続ける
export async function disconnectSquare(deps: SquareDeps, householdId: string): Promise<void> {
  const connection = await deps.store.getSquareConnection(householdId);
  if (connection && deps.squareConfig) {
    try {
      await (deps.fetch ?? fetch)(`${deps.squareConfig.baseUrl}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Client ${deps.squareConfig.applicationSecret}` },
        body: JSON.stringify({ client_id: deps.squareConfig.applicationId, merchant_id: connection.merchant_id }),
      });
    } catch (e) {
      console.warn("Square の連携を取り消せませんでした", e);
    }
  }
  await deps.store.deleteSquareConnection(householdId);
  if (await deps.store.getProviderKind(householdId) === "square") {
    await deps.store.setProviderKind(householdId, "monban");
  }
}

// Square が呼ぶ。署名を確かめ、予約先が Square の店だけに通知する。読み取りだけなので own_writes は要らない
export async function handleSquareWebhook(deps: SquareDeps, req: Request): Promise<Response> {
  const config = requireConfig(deps.squareConfig);
  if (!config.webhookSignatureKey) {
    return Response.json({ error: "Square の Webhook が設定されていません", code: "square_not_configured" }, { status: 503 });
  }
  const rawBody = await req.text();
  const valid = await hasValidSquareSignature(
    config.webhookSignatureKey,
    `${config.publicUrl}/square/webhook`,
    rawBody,
    req.headers.get("x-square-hmacsha256-signature"),
  );
  if (!valid) return Response.json({ error: "署名が違います" }, { status: 403 });

  let event: { merchant_id?: string; type?: string; data?: { object?: { booking?: SquareBooking } } } | null = null;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "本文が JSON ではありません" }, { status: 400 });
  }
  const booking = event?.data?.object?.booking;
  if (!booking?.id || !event?.merchant_id) return Response.json({ skipped: true });
  const kind = classifyBookingEvent(event.type, booking);
  if (!kind) return Response.json({ skipped: true });

  const connection = await deps.store.squareConnectionByMerchant(event.merchant_id);
  if (!connection || await deps.store.getProviderKind(connection.household_id) !== "square") {
    return Response.json({ skipped: true });
  }

  // 顧客名を読めなくても通知する
  const lookups = deps.squareClient
    ? await resolveBookings(deps.squareClient(connection, config), [booking])
    : {};
  const reservation = bookingToReservation(booking, lookups);
  if (!reservation) return Response.json({ skipped: true });
  // 記録に失敗したら 500 を返し、Square に送り直してもらう（dedupe_key で二重にならない）
  try {
    await deps.notifyOrThrow(reservationNotice(connection.household_id, kind, reservation, squareDedupeKey(booking)));
  } catch (e) {
    console.error("Square webhook notification failed", e);
    return Response.json({ error: "通知を記録できませんでした" }, { status: 500 });
  }
  return Response.json({ notified: true });
}
