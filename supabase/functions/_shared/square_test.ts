// deno test --allow-env supabase/functions/_shared/
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import type { NewNotification } from "./notify.ts";
import { type NewReservation, ProviderError, type Reservation, type ReservationWrite } from "./reservation.ts";
import {
  bookingStatus,
  bookingToReservation,
  catalogNames,
  classifyBookingEvent,
  hasValidSquareSignature,
  resolveBookings,
  type SquareBooking,
  SquareApiError,
  SquareAuthError,
  SquareClient,
  type SquareConnection,
  squareDedupeKey,
  SquareProvider,
  squareSignature,
  SquareTokens,
} from "./square.ts";
import { decryptToken, encryptToken } from "./token_crypto.ts";

const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const config = {
  applicationId: "app",
  applicationSecret: "secret",
  baseUrl: "https://connect.squareupsandbox.com",
  publicUrl: "https://example.test/functions/v1/reservations",
  tokenKey,
  webhookSignatureKey: "signature-key",
};
const tokens = {
  accessToken: () => Promise.resolve("access"),
  markFailed: () => Promise.resolve(),
  markHealthy: () => Promise.resolve(),
};
const booking: SquareBooking = {
  id: "b1",
  version: 2,
  status: "ACCEPTED",
  start_at: "2026-11-02T05:00:00Z",
  customer_id: "c1",
  customer_note: "初回",
  appointment_segments: [
    { duration_minutes: 60, service_variation_id: "v1" },
    { duration_minutes: 30, service_variation_id: "v2" },
  ],
};
const ledgerRow: Reservation = {
  id: "11111111-1111-4111-8111-111111111111",
  customer_name: "佐藤",
  customer_phone: null,
  service_name: null,
  starts_at: "2026-11-02T03:00:00.000Z",
  ends_at: "2026-11-02T04:00:00.000Z",
  status: "pending",
  source: "ai",
  note: null,
  arrived_at: null,
  visit_id: null,
  read_only: false,
};
const write: ReservationWrite = { reservation: ledgerRow, dedupeKey: (kind) => `ledger:${kind}` };

function fakeFetch(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fn as typeof fetch, calls };
}

function provider(bookings: SquareBooking[] = [booking], overrides: { customers?: () => Promise<Map<string, { name: string; phone: string | null }>> } = {}) {
  const arrivals = new Map<string, string>();
  const ledgerCalls: string[] = [];
  const ledger = {
    list: () => {
      ledgerCalls.push("list");
      return Promise.resolve([ledgerRow]);
    },
    get: () => Promise.resolve(ledgerRow),
    createIfFree: (input: NewReservation) => {
      ledgerCalls.push(`create:${input.source}`);
      return Promise.resolve(write);
    },
    update: () => Promise.resolve(write),
    approve: () => Promise.resolve(write),
    cancel: () => Promise.resolve(write),
    arrive: () => Promise.resolve(write),
  };
  const listRanges: { min: string; max: string }[] = [];
  const instance = new SquareProvider({
    client: {
      listBookings: (min, max) => {
        listRanges.push({ min: min.toISOString(), max: max.toISOString() });
        return Promise.resolve(bookings);
      },
      getBooking: (id) => Promise.resolve(bookings.find((b) => b.id === id) ?? null),
      customers: overrides.customers ?? (() => Promise.resolve(new Map([["c1", { name: "田中 花子", phone: "090" }]]))),
      serviceNames: () => Promise.resolve(new Map([["v1", "ジェルネイル"]])),
    },
    ledger,
    store: {
      externalArrivals: (_, __, ids) => Promise.resolve(new Map([...arrivals].filter(([id]) => ids.includes(id)))),
      recordExternalArrival: (_, __, id, at) => {
        arrivals.set(id, at);
        return Promise.resolve();
      },
    },
    householdId: "h1",
    now: () => new Date("2026-11-02T04:50:00.000Z"),
  });
  return { instance, arrivals, ledgerCalls, listRanges };
}

const range = { from: "2026-11-02T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" };

async function assertProviderError(fn: () => Promise<unknown>, status: number, code?: string) {
  const error = await assertRejects(fn, ProviderError) as ProviderError;
  assertEquals(error.status, status);
  if (code) assertEquals(error.code, code);
}

Deno.test("Square の状態を予約の状態に直す", () => {
  assertEquals(bookingStatus("ACCEPTED"), "confirmed");
  assertEquals(bookingStatus("PENDING"), "pending");
  for (const status of ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED", "NO_SHOW"]) {
    assertEquals(bookingStatus(status), "cancelled");
  }
});

Deno.test("予約に直す: 終了は所要時間の合計、id は square: 付き、読み取り専用", () => {
  assertEquals(
    bookingToReservation(booking, {
      customers: new Map([["c1", { name: "田中 花子", phone: "090" }]]),
      services: new Map([["v1", "ジェルネイル"]]),
      arrivals: new Map([["b1", "2026-11-02T04:55:00.000Z"]]),
    }),
    {
      id: "square:b1",
      customer_name: "田中 花子",
      customer_phone: "090",
      service_name: "ジェルネイル",
      starts_at: "2026-11-02T05:00:00.000Z",
      ends_at: "2026-11-02T06:30:00.000Z",
      status: "confirmed",
      source: "external",
      note: "初回",
      arrived_at: "2026-11-02T04:55:00.000Z",
      visit_id: null,
      read_only: true,
    },
  );
  const bare = bookingToReservation({ id: "b2", start_at: "2026-11-02T05:00:00Z" })!;
  assertEquals(bare.customer_name, "お客様");
  assertEquals(bare.service_name, null);
  assertEquals(bookingToReservation({ id: "b3" }), null);
});

Deno.test("一覧: 31 日を超える期間は分けて読み、すべてのページをたどり、重複は1件にする", async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.searchParams.get("cursor") === "next") return Response.json({ bookings: [{ id: "b2" }] });
    if (url.searchParams.get("start_at_min") === "2026-11-01T00:00:00.000Z") {
      return Response.json({ bookings: [{ id: "b1" }], cursor: "next" });
    }
    return Response.json({ bookings: [{ id: "b2" }, { id: "b3" }] });
  });
  const client = new SquareClient(config, tokens, fetch);
  const bookings = await client.listBookings(new Date("2026-11-01T00:00:00Z"), new Date("2027-01-15T00:00:00Z"));
  assertEquals(bookings.map((b) => b.id), ["b1", "b2", "b3"]);
  // 75 日を 31 + 31 + 13 日に分ける。最初の期間は2ページ
  assertEquals(calls.length, 4);
  assertEquals(calls[0].url.pathname, "/v2/bookings");
  assertEquals(calls[0].url.searchParams.get("start_at_max"), "2026-12-02T00:00:00.000Z");
  assertEquals(calls[2].url.searchParams.get("start_at_min"), "2026-12-02T00:00:00.000Z");
  assertEquals(calls[3].url.searchParams.get("start_at_max"), "2027-01-15T00:00:00.000Z");
});

Deno.test("顧客は 100 件ごとに読み、姓名の順に並べる", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `c${i}`);
  const { fetch, calls } = fakeFetch(() =>
    Response.json({ responses: { c0: { customer: { family_name: "田中", given_name: "花子", phone_number: "090" } }, c1: { errors: [{}] }, c2: { customer: {} } } })
  );
  const customers = await new SquareClient(config, tokens, fetch).customers(ids);
  assertEquals(calls.length, 2);
  assertEquals(customers.get("c0"), { name: "田中 花子", phone: "090" });
  assertEquals(customers.has("c1"), false);
  assertEquals(customers.get("c2"), { name: "お客様", phone: null });
});

Deno.test("メニュー名は objects と related_objects の両方から探し、品目名を優先する", () => {
  const names = catalogNames({
    objects: [
      { id: "v1", type: "ITEM_VARIATION", item_variation_data: { name: "Regular", item_id: "i1" } },
      { id: "v2", type: "ITEM_VARIATION", item_variation_data: { name: "60分" } },
      {
        id: "i3",
        type: "ITEM",
        item_data: { name: "マッサージ", variations: [{ id: "v3", item_variation_data: { name: "Regular" } }] },
      },
    ],
    related_objects: [{ id: "i1", type: "ITEM", item_data: { name: "ジェルネイル" } }],
  });
  assertEquals(names.get("v1"), "ジェルネイル");
  assertEquals(names.get("v2"), "60分");
  assertEquals(names.get("v3"), "マッサージ");
  assertEquals(names.has("v4"), false);
});

Deno.test("顧客とメニューを読めなくても予約は返す", async () => {
  const fail = () => Promise.reject(new SquareApiError("Square HTTP 403", 403));
  const { customers, services } = await resolveBookings({ customers: fail, serviceNames: fail }, [booking]);
  assertEquals(customers.size, 0);
  assertEquals(services.size, 0);
  const { instance } = provider([booking], { customers: fail });
  const [row] = (await instance.list({ ...range, status: "confirmed" }));
  assertEquals(row.customer_name, "お客様");
  assertEquals(row.service_name, "ジェルネイル");
});

Deno.test("一覧: Square の予約と表の仮予約を時刻の順に合わせ、キャンセルは除く", async () => {
  const cancelled = { ...booking, id: "b2", status: "CANCELLED_BY_SELLER" };
  const { instance, listRanges } = provider([booking, cancelled]);
  const rows = await instance.list(range);
  assertEquals(rows.map((r) => r.id), [ledgerRow.id, "square:b1"]);
  // 期間の前に始まって重なる予約を見つけるため、12 時間前から読む
  assertEquals(listRanges[0].min, "2026-11-01T12:00:00.000Z");
  assertEquals((await instance.list({ ...range, status: "cancelled" })).map((r) => r.id), ["square:b2"]);
});

Deno.test("一覧: 表は仮予約だけを合わせる（確定は Square の本物と二重になる）", async () => {
  const { instance, ledgerCalls } = provider([]);
  assertEquals((await instance.list({ ...range, status: "confirmed" })).length, 0);
  assertEquals(ledgerCalls, []);
  assertEquals((await instance.list({ ...range, status: "pending" })).map((r) => r.id), [ledgerRow.id]);
  assertEquals(ledgerCalls, ["list"]);
});

Deno.test("一覧: 期間と重ならない予約は返さない", async () => {
  const before = { ...booking, id: "old", start_at: "2026-11-01T13:00:00Z", appointment_segments: [{ duration_minutes: 60 }] };
  const across = { ...booking, id: "across", start_at: "2026-11-01T23:30:00Z", appointment_segments: [{ duration_minutes: 60 }] };
  const { instance } = provider([before, across]);
  assertEquals((await instance.list({ ...range, status: "confirmed" })).map((r) => r.id), ["square:across"]);
});

Deno.test("Square の予約は読み取り専用。アプリからは足せず、AI の仮予約だけが表に入る", async () => {
  const { instance, ledgerCalls } = provider();
  const input: NewReservation = {
    customer_name: "田中",
    customer_phone: null,
    service_name: null,
    starts_at: range.from,
    ends_at: range.to,
    note: null,
    status: "confirmed",
    source: "app",
    visit_id: null,
  };
  await assertProviderError(() => instance.create(input), 409, "provider_read_only");
  await assertProviderError(() => instance.update("square:b1", { note: "x" }), 409, "provider_read_only");
  await assertProviderError(() => instance.approve("square:b1"), 409, "provider_read_only");
  await assertProviderError(() => instance.cancel("square:b1"), 409, "provider_read_only");
  assertEquals(ledgerCalls, []);

  const free = { starts_at: "2026-11-02T10:00:00.000Z", ends_at: "2026-11-02T11:00:00.000Z" };
  assertEquals((await instance.createIfFree({ ...input, ...free, status: "pending", source: "ai" })).reservation.id, ledgerRow.id);
  assertEquals(ledgerCalls.at(-1), "create:ai");
  assertEquals((await instance.approve(ledgerRow.id)).reservation.id, ledgerRow.id);
  assertEquals((await instance.cancel(ledgerRow.id)).reservation.id, ledgerRow.id);
});

Deno.test("AI の仮予約は Square の予約と重なれば受けない", async () => {
  const { instance, ledgerCalls } = provider();
  const input: NewReservation = {
    customer_name: "田中",
    customer_phone: null,
    service_name: null,
    starts_at: "2026-11-02T05:30:00.000Z",
    ends_at: "2026-11-02T06:00:00.000Z",
    note: null,
    status: "pending",
    source: "ai",
    visit_id: null,
  };
  await assertProviderError(() => instance.createIfFree(input), 409, "reservation_overlap");
  assertEquals(ledgerCalls.includes("create:ai"), false);
});

Deno.test("到着は Square の予約にも記録でき、通知のキーは予約ごとに1つ", async () => {
  const { instance, arrivals } = provider();
  const first = await instance.arrive("square:b1");
  assertEquals(first.reservation.arrived_at, "2026-11-02T04:50:00.000Z");
  assertEquals(arrivals.get("b1"), "2026-11-02T04:50:00.000Z");
  assertEquals(first.dedupeKey("reservation_arrived"), "square:b1:reservation_arrived");
  assertEquals((await instance.get("square:b1"))?.arrived_at, "2026-11-02T04:50:00.000Z");

  await assertProviderError(() => instance.arrive("square:none"), 404);
  const { instance: cancelled } = provider([{ ...booking, status: "DECLINED" }]);
  await assertProviderError(() => cancelled.arrive("square:b1"), 409);
});

Deno.test("署名は URL と生の本文の HMAC-SHA256 を base64 で比べる", async () => {
  const url = "https://example.test/functions/v1/reservations/square/webhook";
  const signature = await squareSignature("key", url, "{}");
  // openssl dgst の結果と同じ計算であることを固定する
  const manual = await crypto.subtle.sign(
    { name: "HMAC" },
    await crypto.subtle.importKey("raw", new TextEncoder().encode("key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(`${url}{}`),
  );
  assertEquals(signature, btoa(String.fromCharCode(...new Uint8Array(manual))));
  assertEquals(await hasValidSquareSignature("key", url, "{}", signature), true);
  assertEquals(await hasValidSquareSignature("other", url, "{}", signature), false);
  assertEquals(await hasValidSquareSignature("key", url, '{"a":1}', signature), false);
  assertEquals(await hasValidSquareSignature("key", url, "{}", null), false);
});

Deno.test("Webhook の種類を通知の種類に直す", () => {
  assertEquals(classifyBookingEvent("booking.created", { id: "b", status: "PENDING" }), "reservation_pending");
  assertEquals(classifyBookingEvent("booking.created", { id: "b", status: "ACCEPTED" }), "reservation_created");
  assertEquals(classifyBookingEvent("booking.updated", { id: "b", status: "ACCEPTED" }), "reservation_updated");
  assertEquals(classifyBookingEvent("booking.updated", { id: "b", status: "CANCELLED_BY_CUSTOMER" }), "reservation_cancelled");
  assertEquals(classifyBookingEvent("customer.updated", { id: "b" }), null);
  assertEquals(squareDedupeKey({ id: "b", version: 3 }), "square:b:3");
});

async function tokenSetup(handler: (url: URL, init: RequestInit) => Response, overrides: Partial<SquareConnection> = {}) {
  const connection: SquareConnection = {
    household_id: "h1",
    merchant_id: "m1",
    merchant_name: "ネイルサロン",
    access_token_encrypted: await encryptToken("old-access", tokenKey),
    refresh_token_encrypted: await encryptToken("refresh", tokenKey),
    access_token_expires_at: "2026-11-05T00:00:00Z",
    status: "active",
    last_error: null,
    connected_by: "u1",
    ...overrides,
  };
  const saved: Partial<SquareConnection>[] = [];
  const sent: NewNotification[] = [];
  const fake = fakeFetch(handler);
  const instance = new SquareTokens(
    connection,
    config,
    {
      updateSquareConnection(_, update) {
        saved.push(update);
        return Promise.resolve();
      },
    },
    (notification) => {
      sent.push(notification);
      return Promise.resolve();
    },
    fake.fetch,
    () => new Date("2026-11-02T00:00:00Z"),
  );
  return { instance, saved, sent, calls: fake.calls };
}

Deno.test("期限まで余裕があればトークンを更新しない", async () => {
  const { instance, calls } = await tokenSetup(() => new Response(null, { status: 500 }), {
    access_token_expires_at: "2026-11-30T00:00:00Z",
  });
  assertEquals(await instance.accessToken(), "old-access");
  assertEquals(calls.length, 0);
});

Deno.test("期限が近ければ更新して保存し、接続を正常に戻す", async () => {
  const { instance, saved, calls } = await tokenSetup(
    () => Response.json({ access_token: "new-access", expires_at: "2026-12-02T00:00:00Z" }),
    { status: "error", last_error: "前の失敗" },
  );
  assertEquals(await instance.accessToken(), "new-access");
  assertEquals(calls[0].url.href, `${config.baseUrl}/oauth2/token`);
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.grant_type, "refresh_token");
  assertEquals(body.refresh_token, "refresh");
  assertEquals(saved[0].status, "active");
  assertEquals(saved[0].last_error, null);
  assertEquals(saved[0].access_token_expires_at, "2026-12-02T00:00:00Z");
  assertEquals(await decryptToken(saved[0].access_token_encrypted!, tokenKey), "new-access");
  // 保存した新しいトークンを続けて使う
  assertEquals(await instance.accessToken(), "new-access");
  assertEquals(calls.length, 1);
});

Deno.test("更新が拒否されたら接続を error にして1回だけ通知する", async () => {
  const { instance, saved, sent } = await tokenSetup(() => Response.json({ errors: [{}] }, { status: 401 }));
  await assertRejects(() => instance.accessToken(), SquareAuthError);
  await assertRejects(() => instance.accessToken(), SquareAuthError);
  assertEquals(saved[0].status, "error");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].kind, "calendar_sync_failed");
});

Deno.test("発行から 7 日たったら更新する（残りが 23 日を切ったら）", async () => {
  const fresh = await tokenSetup(() => new Response(null, { status: 500 }), { access_token_expires_at: "2026-11-25T01:00:00Z" });
  assertEquals(await fresh.instance.accessToken(), "old-access");
  assertEquals(fresh.calls.length, 0);

  const aged = await tokenSetup(() => Response.json({ access_token: "new-access", expires_at: "2026-12-02T00:00:00Z" }), {
    access_token_expires_at: "2026-11-24T23:00:00Z",
  });
  assertEquals(await aged.instance.accessToken(), "new-access");
});

Deno.test("通信の失敗は一時的な失敗として扱う", async () => {
  const offline = (() => Promise.reject(new TypeError("network"))) as typeof fetch;
  const connection = {
    household_id: "h1",
    merchant_id: "m1",
    merchant_name: null,
    access_token_encrypted: await encryptToken("old-access", tokenKey),
    refresh_token_encrypted: await encryptToken("refresh", tokenKey),
    access_token_expires_at: "2026-11-05T00:00:00Z",
    status: "active" as const,
    last_error: null,
    connected_by: "u1",
  };
  const tokens = new SquareTokens(connection, config, { updateSquareConnection: () => Promise.resolve() }, () => Promise.resolve(), offline, () => new Date("2026-11-02T00:00:00Z"));
  await assertRejects(() => tokens.accessToken(), SquareApiError);

  const client = new SquareClient(config, {
    accessToken: () => Promise.resolve("t"),
    markFailed: () => Promise.resolve(),
    markHealthy: () => Promise.resolve(),
  }, offline);
  await assertRejects(() => client.getBooking("b1"), SquareApiError);
});

Deno.test("更新の一時的な失敗では接続を error にしない", async () => {
  const { instance, saved, sent } = await tokenSetup(() => new Response(null, { status: 503 }));
  await assertRejects(() => instance.accessToken(), SquareApiError);
  assertEquals(saved.length, 0);
  assertEquals(sent.length, 0);
});

Deno.test("API の 401 は接続を error にし、読めたら正常に戻す", async () => {
  let failed = 0;
  let healthy = 0;
  const responses = [new Response(null, { status: 401 }), Response.json({ bookings: [] })];
  const { fetch } = fakeFetch(() => responses.shift()!);
  const client = new SquareClient(config, {
    accessToken: () => Promise.resolve("access"),
    markFailed: () => {
      failed++;
      return Promise.resolve();
    },
    markHealthy: () => {
      healthy++;
      return Promise.resolve();
    },
  }, fetch);
  const from = new Date("2026-11-01T00:00:00Z");
  const to = new Date("2026-11-02T00:00:00Z");
  await assertRejects(() => client.listBookings(from, to), SquareAuthError);
  assertEquals(failed, 1);
  assertEquals(await client.listBookings(from, to), []);
  assertEquals(healthy, 1);
});

Deno.test("API の 5xx は一時的な失敗として返す", async () => {
  const { fetch } = fakeFetch(() => new Response(null, { status: 503 }));
  await assertRejects(
    () => new SquareClient(config, tokens, fetch).listBookings(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-02T00:00:00Z")),
    SquareApiError,
  );
});
