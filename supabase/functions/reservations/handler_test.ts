// deno test supabase/functions/reservations/
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { decryptToken } from "../_shared/token_crypto.ts";
import { GoogleAuthError, GoogleSyncExpired } from "../_shared/google_calendar.ts";
import type { NewNotification } from "../_shared/notify.ts";
import { ProviderError, type Reservation, type ReservationProvider, type ReservationWrite } from "../_shared/reservation.ts";
import { SquareAuthError, squareSignature } from "../_shared/square.ts";
import { baseConnection, fakeGoogle, memoryStore } from "../_shared/testing.ts";
import { isAllowedReturnUrl } from "./google.ts";
import { handleReservationsRequest, type ReservationsDeps } from "./handler.ts";

const reservation: Reservation = {
  id: "r1",
  customer_name: "田中",
  customer_phone: null,
  service_name: null,
  starts_at: "2026-11-02T05:00:00.000Z",
  ends_at: "2026-11-02T06:00:00.000Z",
  status: "pending",
  source: "ai",
  note: null,
  arrived_at: null,
  visit_id: null,
  read_only: false,
};
const write: ReservationWrite = { reservation, dedupeKey: (kind) => `v1:${kind}` };
const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const config = { clientId: "id", clientSecret: "secret", publicUrl: "https://example.test/functions/v1/reservations", tokenKey };

function provider(overrides: Partial<ReservationProvider> = {}): ReservationProvider {
  return {
    kind: "monban",
    list: () => Promise.resolve([reservation]),
    get: (id) => Promise.resolve(id === "r1" ? reservation : null),
    create: () => Promise.resolve(write),
    createIfFree: () => Promise.resolve(write),
    update: () => Promise.resolve(write),
    approve: () => Promise.resolve(write),
    cancel: () => Promise.resolve(write),
    arrive: () => Promise.resolve(write),
    ...overrides,
  };
}

function setup(overrides: Partial<ReservationsDeps> = {}, storeOptions: Parameters<typeof memoryStore>[0] = {}) {
  const { store, state } = memoryStore(storeOptions);
  const sent: NewNotification[] = [];
  const deps: ReservationsDeps = {
    store,
    config: null,
    authenticate: () => Promise.resolve({ userId: "u1", householdId: "h1" }),
    providerFor: () => Promise.resolve(provider()),
    notify: (notification) => {
      sent.push(notification);
      return Promise.resolve();
    },
    notifyOrThrow: (notification) => {
      sent.push(notification);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, sent, state };
}

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`https://example.test/functions/v1/reservations${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const range = "?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z";
const newReservation = {
  customer_name: "田中",
  starts_at: "2026-11-02T14:00:00+09:00",
  ends_at: "2026-11-02T15:00:00+09:00",
};

Deno.test("ログインしていなければ 401、グループに入っていなければ 403", async () => {
  const anonymous = setup({ authenticate: () => Promise.resolve(null) });
  assertEquals((await handleReservationsRequest(request(range), anonymous.deps)).status, 401);
  const outsider = setup({ authenticate: () => Promise.resolve("forbidden") });
  assertEquals((await handleReservationsRequest(request(range), outsider.deps)).status, 403);
});

Deno.test("Edge Runtime がパスの頭を落としても同じ経路になる", async () => {
  const { deps } = setup();
  const res = await handleReservationsRequest(new Request(`https://example.test/reservations${range}`), deps);
  assertEquals(res.status, 200);
});

Deno.test("一覧は予約先の種類と予約を返し、期間がなければ 400", async () => {
  const { deps } = setup();
  const res = await handleReservationsRequest(request(range), deps);
  assertEquals(await res.json(), { provider: "monban", reservations: [reservation] });
  assertEquals((await handleReservationsRequest(request(""), deps)).status, 400);
});

Deno.test("手入力は確定で作り、操作した本人を除いて通知する", async () => {
  let created: unknown;
  const { deps, sent } = setup({
    providerFor: () =>
      Promise.resolve(provider({
        create(input) {
          created = input;
          return Promise.resolve(write);
        },
      })),
  });
  const res = await handleReservationsRequest(request("", "POST", { ...newReservation, status: "pending", source: "ai" }), deps);
  assertEquals(res.status, 201);
  assertEquals((created as { status: string; source: string }).status, "confirmed");
  assertEquals((created as { status: string; source: string }).source, "app");
  assertEquals(sent.map((n) => [n.kind, n.actor_user_id, n.dedupe_key]), [["reservation_created", "u1", "v1:reservation_created"]]);
});

Deno.test("操作ごとに通知の種類を決める", async () => {
  const cases: [string, string, string, unknown][] = [
    ["/r1", "PATCH", "reservation_updated", { note: "変更" }],
    ["/r1/approve", "POST", "reservation_updated", undefined],
    ["/r1/cancel", "POST", "reservation_cancelled", undefined],
    ["/r1/arrive", "POST", "reservation_arrived", undefined],
  ];
  for (const [path, method, kind, body] of cases) {
    const { deps, sent } = setup();
    const res = await handleReservationsRequest(request(path, method, body), deps);
    assertEquals(res.status, 200);
    assertEquals(sent[0].kind, kind);
  }
  const { deps, sent } = setup();
  await handleReservationsRequest(request("/r1/approve", "POST"), deps);
  assertEquals(sent[0].title, "予約を確定しました");
});

Deno.test("1件の取得と失敗の返事", async () => {
  const { deps } = setup();
  assertEquals((await handleReservationsRequest(request("/r1"), deps)).status, 200);
  assertEquals((await handleReservationsRequest(request("/none"), deps)).status, 404);
  assertEquals((await handleReservationsRequest(request("/r1/approve"), deps)).status, 405);

  const conflict = setup({
    providerFor: () => Promise.resolve(provider({ approve: () => Promise.reject(new ProviderError(409, "仮予約ではありません")) })),
  });
  const res = await handleReservationsRequest(request("/r1/approve", "POST"), conflict.deps);
  assertEquals(res.status, 409);
  assertEquals(conflict.sent.length, 0);

  const revoked = setup({ providerFor: () => Promise.reject(new GoogleAuthError("revoked")) });
  const reauth = await handleReservationsRequest(request(range), revoked.deps);
  assertEquals(reauth.status, 502);
  assertEquals((await reauth.json()).code, "google_reauth_required");
});

Deno.test("Google は接続とカレンダーの選択が済むまで予約先にできない", async () => {
  const none = setup();
  assertEquals((await handleReservationsRequest(request("/provider", "PUT", { provider: "google_calendar" }), none.deps)).status, 409);
  assertEquals((await handleReservationsRequest(request("/provider", "PUT", { provider: "x" }), none.deps)).status, 400);
  const res = await handleReservationsRequest(request("/provider", "PUT", { provider: "hotpepper" }), none.deps);
  assertEquals((await res.json()).provider, "hotpepper");

  const noCalendar = setup({}, { connection: { ...baseConnection, calendar_id: null } });
  assertEquals((await handleReservationsRequest(request("/provider", "PUT", { provider: "google_calendar" }), noCalendar.deps)).status, 409);

  const ready = setup({}, { connection: baseConnection });
  const saved = await handleReservationsRequest(request("/provider", "PUT", { provider: "google_calendar" }), ready.deps);
  const json = await saved.json();
  assertEquals(json.provider, "google_calendar");
  assertEquals(json.google.calendar_name, "予約");
  // 更新トークンは返さない
  assertEquals(JSON.stringify(json).includes("refresh"), false);
});

Deno.test("OAuth の設定がなければ 503 と分かる error を返す", async () => {
  const { deps } = setup();
  const res = await handleReservationsRequest(request("/google/start", "POST", { return_url: "tka2601://x" }), deps);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "google_not_configured");
});

Deno.test("return_url はアプリのスキームだけを許す", () => {
  assertEquals(isAllowedReturnUrl("tka2601://settings/provider"), true);
  for (const url of ["https://evil.example", "exp://x", "//evil.example", "tka2601://x\\y", 1, undefined]) {
    assertEquals(isAllowedReturnUrl(url), false);
  }
});

function pendingCode(res: Response, provider: "google" | "square"): string {
  const location = new URL(res.headers.get("location")!);
  assertEquals(location.searchParams.get(provider), "pending");
  return location.searchParams.get("code")!;
}

Deno.test("パスの % が不正なら 400", async () => {
  const { deps } = setup();
  assertEquals((await handleReservationsRequest(request("/%E0%A4%A/approve", "POST"), deps)).status, 400);
  assertEquals((await handleReservationsRequest(request("/%E0%A4%A"), deps)).status, 400);
});

Deno.test("syncToken の失効が予約の操作で返っても 500 にしない", async () => {
  const { deps } = setup({ providerFor: () => Promise.reject(new GoogleSyncExpired("x")) });
  const res = await handleReservationsRequest(request(range), deps);
  assertEquals(res.status, 502);
  assertEquals((await res.json()).code, "google_unavailable");
});

Deno.test("OAuth: 同意画面の URL を作り、コールバックではトークンを保留にし、本人の完了で接続にする", async () => {
  const google = fakeGoogle((url) =>
    url.pathname === "/token"
      ? Response.json({ access_token: "access", refresh_token: "plain-refresh" })
      : Response.json({ email: "shop@example.com" })
  );
  const { deps, state } = setup({ config, fetch: google.fetch });

  const bad = await handleReservationsRequest(request("/google/start", "POST", { return_url: "https://evil.example" }), deps);
  assertEquals(bad.status, 400);

  const started = await handleReservationsRequest(request("/google/start", "POST", { return_url: "tka2601://settings" }), deps);
  const url = new URL((await started.json()).url);
  assertEquals(url.searchParams.get("access_type"), "offline");
  assertEquals(url.searchParams.get("prompt"), "consent");
  assertEquals(url.searchParams.get("redirect_uri"), `${config.publicUrl}/google/callback`);
  assertStringIncludes(url.searchParams.get("scope")!, "calendar.events");
  const oauthState = url.searchParams.get("state")!;

  // コールバックは JWT なしで通る
  const noAuth = { ...deps, authenticate: () => Promise.resolve(null) };
  const back = await handleReservationsRequest(request(`/google/callback?state=${oauthState}&code=abc`), noAuth);
  assertEquals(back.status, 302);
  const code = pendingCode(back, "google");
  assertStringIncludes(back.headers.get("location")!, "tka2601://settings?google=pending&code=");

  // 同意しただけでは接続にならず、トークンは暗号化して保留にする
  assertEquals(state.connection, null);
  const pending = state.pending.get(code)!;
  assertEquals(pending.payload_encrypted.includes("plain-refresh"), false);
  assertEquals([pending.provider, pending.user_id, pending.household_id], ["google_calendar", "u1", "h1"]);

  // state は使い切り
  const replay = await handleReservationsRequest(request(`/google/callback?state=${oauthState}&code=abc`), noAuth);
  assertEquals(replay.status, 400);

  // 完了には JWT が要る
  assertEquals((await handleReservationsRequest(request("/google/complete", "POST", { code }), noAuth)).status, 401);
  assertEquals(state.pending.has(code), true);

  const completed = await handleReservationsRequest(request("/google/complete", "POST", { code }), deps);
  assertEquals(completed.status, 200);
  const json = await completed.json();
  assertEquals([json.provider, json.google.connected, json.google.account_email], ["monban", true, "shop@example.com"]);
  assertEquals(await decryptToken(state.connection!.refresh_token_encrypted, tokenKey), "plain-refresh");
  assertEquals(state.connection?.connected_by, "u1");

  // 完了の値も使い切り
  const again = await handleReservationsRequest(request("/google/complete", "POST", { code }), deps);
  assertEquals(again.status, 404);
  assertEquals((await again.json()).code, "oauth_code_invalid");
});

Deno.test("OAuth: 他人が完了を呼ぶと 403 で保留を消し、接続を作らない", async () => {
  const google = fakeGoogle((url) =>
    url.pathname === "/token"
      ? Response.json({ access_token: "access", refresh_token: "plain-refresh" })
      : Response.json({ email: "victim@example.com" })
  );
  const { deps, state } = setup({ config, fetch: google.fetch });
  const started = await handleReservationsRequest(request("/google/start", "POST", { return_url: "tka2601://settings" }), deps);
  const oauthState = new URL((await started.json()).url).searchParams.get("state");
  const code = pendingCode(await handleReservationsRequest(request(`/google/callback?state=${oauthState}&code=abc`), deps), "google");

  const other = { ...deps, authenticate: () => Promise.resolve({ userId: "someone", householdId: "h2" }) };
  const res = await handleReservationsRequest(request("/google/complete", "POST", { code }), other);
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "oauth_user_mismatch");
  assertEquals(state.connection, null);
  assertEquals(state.pending.has(code), false);

  // 同じ人でも、始めたときと別の店なら確定しない
  const started2 = await handleReservationsRequest(request("/google/start", "POST", { return_url: "tka2601://settings" }), deps);
  const state2 = new URL((await started2.json()).url).searchParams.get("state");
  const code2 = pendingCode(await handleReservationsRequest(request(`/google/callback?state=${state2}&code=abc`), deps), "google");
  const moved = { ...deps, authenticate: () => Promise.resolve({ userId: "u1", householdId: "h2" }) };
  assertEquals((await handleReservationsRequest(request("/google/complete", "POST", { code: code2 }), moved)).status, 403);
  assertEquals(state.connection, null);
});

Deno.test("OAuth: 期限切れ、不明、別の予約先の完了の値は 404", async () => {
  const google = fakeGoogle((url) =>
    url.pathname === "/token" ? Response.json({ access_token: "a", refresh_token: "r" }) : Response.json({ email: "s@example.com" })
  );
  const { deps, state } = setup({ config, squareConfig, fetch: google.fetch });
  const start = async () => {
    const started = await handleReservationsRequest(request("/google/start", "POST", { return_url: "tka2601://s" }), deps);
    const oauthState = new URL((await started.json()).url).searchParams.get("state");
    return pendingCode(await handleReservationsRequest(request(`/google/callback?state=${oauthState}&code=abc`), deps), "google");
  };

  for (const code of ["unknown", "", 1, undefined]) {
    const res = await handleReservationsRequest(request("/google/complete", "POST", { code }), deps);
    assertEquals([res.status, (await res.json()).code], [404, "oauth_code_invalid"]);
  }

  const expiring = await start();
  const later = { ...deps, now: () => new Date(Date.now() + 11 * 60 * 1000) };
  assertEquals((await handleReservationsRequest(request("/google/complete", "POST", { code: expiring }), later)).status, 404);

  const wrongProvider = await start();
  assertEquals((await handleReservationsRequest(request("/square/complete", "POST", { code: wrongProvider }), deps)).status, 404);
  assertEquals(state.connection, null);
});

Deno.test("OAuth: 拒否と更新トークンのない応答はアプリへ結果を返し、接続を作らない", async () => {
  const google = fakeGoogle(() => Response.json({ access_token: "access" }));
  const { deps, state } = setup({ config, fetch: google.fetch });
  for (const [params, result] of [["error=access_denied", "cancelled"], ["code=abc", "error"]]) {
    const started = await handleReservationsRequest(request("/google/start", "POST", { return_url: "tka2601://s?a=1" }), deps);
    const oauthState = new URL((await started.json()).url).searchParams.get("state");
    const back = await handleReservationsRequest(request(`/google/callback?state=${oauthState}&${params}`), deps);
    assertEquals(back.headers.get("location"), `tka2601://s?a=1&google=${result}`);
  }
  assertEquals(state.connection, null);
});

Deno.test("カレンダーを選ぶと差分の起点を取り直し、解除すると予約帳に戻す", async () => {
  const { encryptToken } = await import("../_shared/token_crypto.ts");
  const encrypted = await encryptToken("refresh", tokenKey);
  const google = fakeGoogle((url) => {
    if (url.pathname.endsWith("/calendarList")) {
      return Response.json({ items: [{ id: "cal-2", summary: "別の予約", primary: false }] });
    }
    if (url.pathname.endsWith("/revoke")) return Response.json({});
    return Response.json({ items: [], nextSyncToken: "fresh" });
  });
  const { deps, state } = setup({ config, fetch: google.fetch }, {
    connection: { ...baseConnection, refresh_token_encrypted: encrypted },
    provider: "google_calendar",
  });

  const list = await handleReservationsRequest(request("/google/calendars"), deps);
  assertEquals(await list.json(), { calendars: [{ id: "cal-2", name: "別の予約", primary: false }] });
  assertEquals((await handleReservationsRequest(request("/google/calendar", "PUT", { calendar_id: "none" }), deps)).status, 404);

  const selected = await handleReservationsRequest(request("/google/calendar", "PUT", { calendar_id: "cal-2" }), deps);
  assertEquals((await selected.json()).google.calendar_name, "別の予約");
  assertEquals([state.connection?.calendar_id, state.connection?.sync_token], ["cal-2", "fresh"]);
  // 接続の更新トークンを残したまま、変える項目だけを送る
  assertEquals(state.connection?.refresh_token_encrypted, encrypted);
  assertEquals("refresh_token_encrypted" in state.saved.at(-1)!, false);

  const removed = await handleReservationsRequest(request("/google", "DELETE"), deps);
  const json = await removed.json();
  assertEquals([json.provider, json.google.connected], ["monban", false]);
  assertEquals(google.calls.some((c) => c.url.pathname.endsWith("/revoke")), true);
});

// Square ----------------------------------------------------------------------

const squareConfig = {
  applicationId: "sq-app",
  applicationSecret: "sq-secret",
  baseUrl: "https://connect.squareupsandbox.com",
  publicUrl: "https://example.test/functions/v1/reservations",
  tokenKey,
  webhookSignatureKey: "sq-key",
};

const squareConnection = {
  household_id: "h1",
  merchant_id: "m1",
  merchant_name: "ネイルサロン",
  access_token_encrypted: "unused",
  refresh_token_encrypted: "unused",
  access_token_expires_at: "2026-12-01T00:00:00Z",
  status: "active" as const,
  last_error: null,
  connected_by: "u1",
};

function fakeSquare(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fn as typeof fetch, calls };
}

Deno.test("Square の設定がなければ接続を始められない", async () => {
  const { deps } = setup();
  const res = await handleReservationsRequest(request("/square/start", "POST", { return_url: "tka2601://x" }), deps);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "square_not_configured");
});

Deno.test("Square の接続: 同意画面の URL、トークンの暗号化、店名、アプリへの転送", async () => {
  const square = fakeSquare((url) =>
    url.pathname === "/oauth2/token"
      ? Response.json({ access_token: "access", refresh_token: "refresh", merchant_id: "m1", expires_at: "2026-12-01T00:00:00Z" })
      : Response.json({ merchant: { business_name: "ネイルサロン" } })
  );
  const { deps, state } = setup({ squareConfig, fetch: square.fetch });

  const bad = await handleReservationsRequest(request("/square/start", "POST", { return_url: "https://evil.example" }), deps);
  assertEquals(bad.status, 400);

  const started = await handleReservationsRequest(request("/square/start", "POST", { return_url: "tka2601://settings" }), deps);
  const url = new URL((await started.json()).url);
  assertEquals(url.origin + url.pathname, "https://connect.squareupsandbox.com/oauth2/authorize");
  assertEquals(url.searchParams.get("session"), "false");
  assertStringIncludes(url.searchParams.get("scope")!, "APPOINTMENTS_ALL_READ");
  const oauthState = url.searchParams.get("state")!;

  // Google の callback では使えず、使い切りになる
  const wrong = await handleReservationsRequest(request(`/google/callback?state=${oauthState}&code=abc`), { ...deps, config });
  assertEquals(wrong.status, 400);

  const restarted = await handleReservationsRequest(request("/square/start", "POST", { return_url: "tka2601://settings" }), deps);
  const nextState = new URL((await restarted.json()).url).searchParams.get("state")!;
  const noAuth = { ...deps, authenticate: () => Promise.resolve(null) };
  const back = await handleReservationsRequest(request(`/square/callback?state=${nextState}&code=abc`), noAuth);
  const code = pendingCode(back, "square");
  assertEquals(state.square, null);
  assertEquals(state.pending.get(code)?.payload_encrypted.includes("access"), false);

  const other = { ...deps, authenticate: () => Promise.resolve({ userId: "someone", householdId: "h1" }) };
  const denied = await handleReservationsRequest(request("/square/complete", "POST", { code }), other);
  assertEquals([denied.status, (await denied.json()).code], [403, "oauth_user_mismatch"]);
  assertEquals(state.square, null);

  const again = await handleReservationsRequest(request("/square/start", "POST", { return_url: "tka2601://settings" }), deps);
  const againState = new URL((await again.json()).url).searchParams.get("state")!;
  const code2 = pendingCode(await handleReservationsRequest(request(`/square/callback?state=${againState}&code=abc`), noAuth), "square");
  const completed = await handleReservationsRequest(request("/square/complete", "POST", { code: code2 }), deps);
  assertEquals((await completed.json()).square.merchant_name, "ネイルサロン");
  assertEquals(state.square?.merchant_name, "ネイルサロン");
  assertEquals(await decryptToken(state.square!.access_token_encrypted, tokenKey), "access");
  assertEquals(await decryptToken(state.square!.refresh_token_encrypted, tokenKey), "refresh");

  const replay = await handleReservationsRequest(request(`/square/callback?state=${nextState}&code=abc`), noAuth);
  assertEquals(replay.status, 400);
});

Deno.test("Square のアカウントが別の店で使われていれば確定しない", async () => {
  const square = fakeSquare((url) =>
    url.pathname === "/oauth2/token"
      ? Response.json({ access_token: "access", refresh_token: "refresh", merchant_id: "m1", expires_at: "2026-12-01T00:00:00Z" })
      : Response.json({})
  );
  const { deps, state } = setup({ squareConfig, fetch: square.fetch }, { square: { ...squareConnection, household_id: "other-shop" } });
  const started = await handleReservationsRequest(request("/square/start", "POST", { return_url: "tka2601://s" }), deps);
  const oauthState = new URL((await started.json()).url).searchParams.get("state");
  const code = pendingCode(await handleReservationsRequest(request(`/square/callback?state=${oauthState}&code=abc`), deps), "square");
  const res = await handleReservationsRequest(request("/square/complete", "POST", { code }), deps);
  assertEquals([res.status, (await res.json()).code], [409, "square_merchant_in_use"]);
  assertEquals(state.square?.household_id, "other-shop");
});

Deno.test("Square の接続の断りと失敗はアプリに伝える", async () => {
  const square = fakeSquare(() => Response.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 }));
  const { deps, state } = setup({ squareConfig, fetch: square.fetch });
  for (const [params, result] of [["error=access_denied", "cancelled"], ["code=abc", "error"]]) {
    const started = await handleReservationsRequest(request("/square/start", "POST", { return_url: "tka2601://s" }), deps);
    const oauthState = new URL((await started.json()).url).searchParams.get("state");
    const back = await handleReservationsRequest(request(`/square/callback?state=${oauthState}&${params}`), deps);
    assertEquals(back.headers.get("location"), `tka2601://s?square=${result}`);
  }
  assertEquals(state.square, null);
});

Deno.test("予約先の状態: Square の接続と、アプリから足せるか", async () => {
  const unconnected = setup();
  const before = await (await handleReservationsRequest(request("/provider"), unconnected.deps)).json();
  assertEquals(before.square, { connected: false, merchant_name: null, status: null, last_error: null });
  assertEquals(before.capabilities, { create: true });
  const denied = await handleReservationsRequest(request("/provider", "PUT", { provider: "square" }), unconnected.deps);
  assertEquals(denied.status, 409);
  assertEquals((await denied.json()).code, "square_not_connected");

  const { deps, state } = setup({}, { square: squareConnection });
  const after = await (await handleReservationsRequest(request("/provider", "PUT", { provider: "square" }), deps)).json();
  assertEquals(after.provider, "square");
  assertEquals(after.capabilities, { create: false });
  assertEquals(after.square.merchant_name, "ネイルサロン");
  assertEquals(state.provider, "square");
});

Deno.test("Square の解除は取り消しに失敗しても続け、予約先を予約帳に戻す", async () => {
  const square = fakeSquare(() => new Response(null, { status: 500 }));
  const { deps, state } = setup({ squareConfig, fetch: square.fetch }, { square: squareConnection, provider: "square" });
  const res = await handleReservationsRequest(request("/square", "DELETE"), deps);
  assertEquals(res.status, 200);
  assertEquals(state.square, null);
  assertEquals(state.provider, "monban");
  assertEquals(square.calls[0].url.pathname, "/oauth2/revoke");
  assertEquals((square.calls[0].init.headers as Record<string, string>).Authorization, "Client sq-secret");
  assertEquals(JSON.parse(String(square.calls[0].init.body)), { client_id: "sq-app", merchant_id: "m1" });
});

async function webhook(body: unknown, deps: ReservationsDeps, signature?: string) {
  const raw = JSON.stringify(body);
  const url = `${squareConfig.publicUrl}/square/webhook`;
  const req = new Request(url, {
    method: "POST",
    body: raw,
    headers: { "x-square-hmacsha256-signature": signature ?? await squareSignature(squareConfig.webhookSignatureKey, url, raw) },
  });
  return await handleReservationsRequest(req, { ...deps, authenticate: () => Promise.resolve(null) });
}

const bookingEvent = (type: string, status: string) => ({
  merchant_id: "m1",
  type,
  data: {
    type: "booking",
    id: "b1:2",
    object: { booking: { id: "b1", version: 2, status, start_at: "2026-11-02T05:00:00Z", customer_id: "c1", appointment_segments: [{ duration_minutes: 60 }] } },
  },
});

Deno.test("Square の Webhook: 署名が違えば 403", async () => {
  const { deps, sent } = setup({ squareConfig }, { square: squareConnection, provider: "square" });
  const res = await webhook(bookingEvent("booking.created", "ACCEPTED"), deps, "wrong");
  assertEquals(res.status, 403);
  assertEquals(sent.length, 0);
});

Deno.test("Square の Webhook: 予約の変化を通知する。顧客名を読めなくても通知する", async () => {
  const cases: [string, string, string][] = [
    ["booking.created", "ACCEPTED", "reservation_created"],
    ["booking.created", "PENDING", "reservation_pending"],
    ["booking.updated", "ACCEPTED", "reservation_updated"],
    ["booking.updated", "CANCELLED_BY_CUSTOMER", "reservation_cancelled"],
  ];
  for (const [type, status, kind] of cases) {
    const { deps, sent } = setup({
      squareConfig,
      squareClient: () => ({
        customers: () => Promise.reject(new Error("読めない")),
        serviceNames: () => Promise.resolve(new Map()),
      }),
    }, { square: squareConnection, provider: "square" });
    const res = await webhook(bookingEvent(type, status), deps);
    assertEquals(res.status, 200);
    assertEquals(sent.map((n) => n.kind), [kind]);
    assertEquals(sent[0].dedupe_key, "square:b1:2");
    assertEquals(sent[0].data, { reservation_id: "square:b1" });
    assertStringIncludes(sent[0].body, "お客様");
  }
});

Deno.test("Square の Webhook: 通知を記録できなければ 500 を返して送り直してもらう", async () => {
  const quiet: NewNotification[] = [];
  const { deps } = setup({
    squareConfig,
    notify: (notification) => {
      quiet.push(notification);
      return Promise.resolve();
    },
    notifyOrThrow: () => Promise.reject(new Error("db down")),
  }, { square: squareConnection, provider: "square" });
  const res = await webhook(bookingEvent("booking.created", "ACCEPTED"), deps);
  assertEquals(res.status, 500);
  assertEquals(quiet.length, 0);
});

Deno.test("Square の Webhook: 予約先が Square でない店や知らない店には通知しない", async () => {
  const other = setup({ squareConfig }, { square: squareConnection, provider: "monban" });
  assertEquals((await webhook(bookingEvent("booking.created", "ACCEPTED"), other.deps)).status, 200);
  assertEquals(other.sent.length, 0);

  const unknown = setup({ squareConfig }, { square: { ...squareConnection, merchant_id: "other" }, provider: "square" });
  assertEquals((await webhook(bookingEvent("booking.created", "ACCEPTED"), unknown.deps)).status, 200);
  assertEquals(unknown.sent.length, 0);

  const ignored = setup({ squareConfig }, { square: squareConnection, provider: "square" });
  assertEquals((await webhook({ ...bookingEvent("booking.created", "ACCEPTED"), type: "customer.updated" }, ignored.deps)).status, 200);
  assertEquals(ignored.sent.length, 0);
});

Deno.test("Square の読み取り専用と再ログインの失敗を返す", async () => {
  const readOnly = setup({
    providerFor: () =>
      Promise.resolve(provider({
        create: () => Promise.reject(new ProviderError(409, "Square の予約は Square で変更してください", "provider_read_only")),
      })),
  });
  const res = await handleReservationsRequest(
    request("", "POST", { customer_name: "田中", starts_at: "2026-11-02T14:00:00+09:00", ends_at: "2026-11-02T15:00:00+09:00" }),
    readOnly.deps,
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "provider_read_only");

  const reauth = setup({ providerFor: () => Promise.resolve(provider({ list: () => Promise.reject(new SquareAuthError("x")) })) });
  const failed = await handleReservationsRequest(
    request("?from=2026-11-02T00:00:00Z&to=2026-11-03T00:00:00Z"),
    reauth.deps,
  );
  assertEquals(failed.status, 502);
  assertEquals((await failed.json()).code, "square_reauth_required");
});
