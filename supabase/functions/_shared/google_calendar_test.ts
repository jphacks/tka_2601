// deno test supabase/functions/_shared/
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  eventToReservation,
  GoogleApiError,
  GoogleAuthError,
  GoogleClient,
  type GoogleEvent,
  GoogleProvider,
  GoogleSyncExpired,
  idempotentEventId,
  patchToEvent,
  reservationToEvent,
} from "./google_calendar.ts";
import { ProviderError, selectProvider } from "./reservation.ts";
import { fakeGoogle } from "./testing.ts";

const oauth = { clientId: "id", clientSecret: "secret" };
const timed = {
  start: { dateTime: "2026-11-02T14:00:00+09:00" },
  end: { dateTime: "2026-11-02T15:30:00+09:00" },
};

function setup(handler: (url: URL, init: RequestInit) => Response) {
  const google = fakeGoogle(handler);
  const own: { writeId: string; eventId: string | null; callsBefore: number }[] = [];
  const provider = new GoogleProvider(new GoogleClient(oauth, "refresh", google.fetch), "cal@example.com", (writeId, eventId) => {
    own.push({ writeId, eventId, callsBefore: google.calls.filter((c) => c.init.method !== "GET").length });
    return Promise.resolve();
  });
  return { provider, google, own };
}

Deno.test("仮の予定は pending、確定は confirmed、削除は cancelled に直す", () => {
  const event = (status: GoogleEvent["status"]) => eventToReservation({ id: "e", status, summary: "田中", ...timed })?.status;
  assertEquals([event("tentative"), event("confirmed"), event("cancelled")], ["pending", "confirmed", "cancelled"]);
});

Deno.test("Google で直接作られた予定は件名を顧客名、説明をメモ、受付元を external にする", () => {
  assertEquals(eventToReservation({ id: "e", status: "confirmed", summary: "田中さん", description: "初回", ...timed }), {
    id: "e",
    customer_name: "田中さん",
    customer_phone: null,
    service_name: null,
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:30:00.000Z",
    status: "confirmed",
    source: "external",
    note: "初回",
    arrived_at: null,
    visit_id: null,
    read_only: false,
  });
});

Deno.test("終日の予定は予約として扱わない", () => {
  assertEquals(eventToReservation({ id: "e", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } }), null);
});

Deno.test("予約を予定に直すと往復で同じになる（仮予約は tentative、MONBAN の項目は非公開の拡張プロパティ）", () => {
  const input = {
    customer_name: "田中",
    customer_phone: "090",
    service_name: "ジェルネイル",
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:30:00.000Z",
    note: "初回",
    status: "pending" as const,
    source: "ai" as const,
    visit_id: "v1",
  };
  const event = reservationToEvent(input);
  assertEquals(event.status, "tentative");
  assertEquals(event.summary, "田中様 ジェルネイル");
  assertEquals(event.extendedProperties?.private?.monban_customer_phone, "090");
  assertEquals(eventToReservation({ ...event, id: "e" }), { ...input, id: "e", arrived_at: null, read_only: false });
});

Deno.test("変更は変えた項目だけを送り、電話番号を消すときは null を送る", () => {
  const current = eventToReservation({ id: "e", summary: "田中", ...timed })!;
  assertEquals(patchToEvent(current, { note: "変更" }), { description: "変更" });
  assertEquals(patchToEvent(current, { customer_phone: null }), {
    extendedProperties: { private: { monban_customer_phone: null as unknown as string } },
  });
  assertEquals(patchToEvent(current, { service_name: "ケア" }).summary, "田中様 ケア");
});

Deno.test("410 は消された予定と syncToken の失効を区別する", async () => {
  const deleted = setup(() => Response.json({ error: { errors: [{ reason: "deleted" }] } }, { status: 410 }));
  assertEquals(await deleted.provider.get("gone"), null);
  await assertRejects(() => deleted.provider.update("gone", { note: "x" }), ProviderError);

  const expired = fakeGoogle(() => Response.json({ error: { errors: [{ reason: "fullSyncRequired" }] } }, { status: 410 }));
  await assertRejects(() => new GoogleClient(oauth, "refresh", expired.fetch).changes("cal", "t"), GoogleSyncExpired);
});

Deno.test("レート制限の 403 だけを一時的な失敗として扱う", () => {
  assertEquals(new GoogleApiError("x", 403, "rateLimitExceeded").transient, true);
  assertEquals(new GoogleApiError("x", 403, "userRateLimitExceeded").transient, true);
  assertEquals(new GoogleApiError("x", 403, "forbidden").transient, false);
  assertEquals(new GoogleApiError("x", 403).transient, false);
});

Deno.test("AI の仮予約は予定と重なれば作らず、空いていれば仮の予定を作る", async () => {
  const input = {
    customer_name: "田中",
    customer_phone: null,
    service_name: null,
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:00:00.000Z",
    note: null,
    status: "pending" as const,
    source: "ai" as const,
    visit_id: null,
  };
  const busy = setup(() => Response.json({ items: [{ id: "a", status: "confirmed", summary: "A", ...timed }] }));
  await assertRejects(
    () => busy.provider.createIfFree(input),
    ProviderError,
    "その時間にはすでに予約があります",
  );
  assertEquals(busy.google.calls.some((c) => c.init.method === "POST" && c.url.pathname.includes("/events")), false);

  const free = setup((_, init) =>
    init.method === "POST"
      ? Response.json({ id: "new", etag: '"1"', status: "tentative", summary: "田中様", ...timed })
      : Response.json({ items: [] })
  );
  assertEquals((await free.provider.createIfFree(input)).reservation.status, "pending");
});

Deno.test("一覧は singleEvents で読み、終日とキャンセルを除き、status で絞り込める", async () => {
  const { provider, google } = setup(() =>
    Response.json({
      items: [
        { id: "a", status: "confirmed", summary: "A", ...timed },
        { id: "b", status: "tentative", summary: "B", ...timed },
        { id: "c", status: "cancelled", summary: "C", ...timed },
        { id: "d", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } },
      ],
    })
  );
  const range = { from: "2026-11-02T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" };
  assertEquals((await provider.list(range)).map((r) => r.id), ["a", "b"]);
  assertEquals((await provider.list({ ...range, status: "pending" })).map((r) => r.id), ["b"]);
  const eventsCall = google.calls.find((c) => c.url.pathname.includes("/events"))!;
  assertEquals(eventsCall.url.pathname, "/calendar/v3/calendars/cal%40example.com/events");
  assertEquals(eventsCall.url.searchParams.get("singleEvents"), "true");
  assertEquals(eventsCall.url.searchParams.get("timeMin"), range.from);
});

Deno.test("一覧はページをたどる", async () => {
  const { provider } = setup((url) =>
    url.searchParams.get("pageToken") === "p2"
      ? Response.json({ items: [{ id: "b", status: "confirmed", summary: "B", ...timed }] })
      : Response.json({ items: [{ id: "a", status: "confirmed", summary: "A", ...timed }], nextPageToken: "p2" })
  );
  const list = await provider.list({ from: "2026-11-02T00:00:00Z", to: "2026-11-03T00:00:00Z" });
  assertEquals(list.map((r) => r.id), ["a", "b"]);
});

const newReservation = {
  customer_name: "田中",
  customer_phone: null,
  service_name: null,
  starts_at: "2026-11-02T05:00:00.000Z",
  ends_at: "2026-11-02T06:30:00.000Z",
  note: null,
  status: "pending" as const,
  source: "ai" as const,
  visit_id: null,
};

Deno.test("書く前に書き込みの id を記録して予定に入れ、通知のキーは google:<id>:<etag> になる", async () => {
  let body: GoogleEvent | null = null;
  const { provider, own } = setup((_, init) => {
    body = JSON.parse(String(init.body));
    assertEquals(body?.status, "tentative");
    return Response.json({ id: "new", etag: '"v1"', status: "tentative", summary: "田中様", ...timed });
  });
  const write = await provider.create(newReservation);
  assertEquals(own.length, 1);
  assertEquals(own[0].eventId, null);
  assertEquals(own[0].callsBefore, 0);
  assertEquals((body as GoogleEvent | null)?.extendedProperties?.private?.monban_write, own[0].writeId);
  assertEquals(write.dedupeKey("reservation_pending"), 'google:new:"v1"');
  assertEquals(write.existed, undefined);
});

Deno.test("承認、キャンセル、到着、変更も書く前に記録し、印を入れる", async () => {
  const bodies: GoogleEvent[] = [];
  const { provider, own } = setup((_, init) => {
    if (init.method === "GET") return Response.json({ id: "e1", etag: '"v1"', status: "tentative", summary: "田中様", ...timed });
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ id: "e1", etag: '"v2"', status: "confirmed", summary: "田中様", ...timed });
  });
  await provider.update("e1", { note: "メモ" });
  await provider.approve("e1");
  await provider.cancel("e1");
  await provider.arrive("e1");
  assertEquals(own.map((o) => o.eventId), ["e1", "e1", "e1", "e1"]);
  assertEquals(new Set(own.map((o) => o.writeId)).size, 4);
  assertEquals(bodies.map((b) => b.extendedProperties?.private?.monban_write), own.map((o) => o.writeId));
  assertEquals(typeof bodies[3].extendedProperties?.private?.monban_arrived_at, "string");
});

Deno.test("冪等キーの予定の id は Google の文字種に合い、同じキーなら同じになる", async () => {
  const id = await idempotentEventId("cal@example.com", "Key-12345");
  assertEquals(/^[a-v0-9]{5,1024}$/.test(id), true);
  assertEquals(id, await idempotentEventId("cal@example.com", "Key-12345"));
  assertEquals(id === await idempotentEventId("cal@example.com", "Key-12346"), false);
  assertEquals(id === await idempotentEventId("other@example.com", "Key-12345"), false);
});

Deno.test("同じ冪等キーの予定があれば Google の 409 から既存を返す", async () => {
  const expectedId = await idempotentEventId("cal@example.com", "Key-12345");
  const { provider, google } = setup((url, init) => {
    if (init.method === "POST") {
      assertEquals(JSON.parse(String(init.body)).id, expectedId);
      return Response.json({ error: { code: 409, errors: [{ reason: "duplicate" }] } }, { status: 409 });
    }
    assertEquals(url.pathname.endsWith(`/events/${expectedId}`), true);
    return Response.json({ id: expectedId, etag: '"v1"', status: "confirmed", summary: "田中様", ...timed });
  });
  const write = await provider.create({ ...newReservation, status: "confirmed", source: "app", idempotency_key: "Key-12345" });
  assertEquals(write.existed, true);
  assertEquals(write.reservation.id, expectedId);
  assertEquals(google.calls.filter((c) => c.url.pathname.includes("/events")).map((c) => c.init.method), ["POST", "GET"]);
});

Deno.test("冪等キーで作るときの 409 で予定が読めなければ、そのまま失敗にする", async () => {
  const { provider } = setup((_, init) =>
    init.method === "POST"
      ? Response.json({ error: { code: 409, errors: [] } }, { status: 409 })
      : Response.json({ error: { code: 404, errors: [] } }, { status: 404 })
  );
  await assertRejects(() => provider.create({ ...newReservation, idempotency_key: "Key-12345" }), GoogleApiError);
});

Deno.test("見ていた時刻と違えば予約を変えない", async () => {
  const { provider, google } = setup(() => Response.json({ id: "e1", etag: '"v1"', status: "confirmed", summary: "田中様", ...timed }));
  const error = await assertRejects(
    () => provider.update("e1", { note: "メモ" }, { starts_at: "2026-11-02T00:00:00.000Z" }),
    ProviderError,
  );
  assertEquals([error.status, error.code], [409, "reservation_changed"]);
  assertEquals(google.calls.filter((c) => c.init.method === "PATCH").length, 0);
});

Deno.test("時刻を渡すと If-Match で書き、412 は reservation_changed にする", async () => {
  const { provider, google } = setup((_, init) => {
    if (init.method === "GET") return Response.json({ id: "e1", etag: '"v1"', status: "confirmed", summary: "田中様", ...timed });
    return Response.json({ error: { code: 412, errors: [] } }, { status: 412 });
  });
  const error = await assertRejects(
    () => provider.update("e1", { note: "メモ" }, { starts_at: timed.start.dateTime }),
    ProviderError,
  );
  assertEquals([error.status, error.code], [409, "reservation_changed"]);
  const patch = google.calls.find((c) => c.init.method === "PATCH")!;
  assertEquals(new Headers(patch.init.headers).get("If-Match"), '"v1"');
});

Deno.test("時刻を渡さなければ If-Match を付けない", async () => {
  const { provider, google } = setup(() => Response.json({ id: "e1", etag: '"v1"', status: "confirmed", summary: "田中様", ...timed }));
  await provider.update("e1", { note: "メモ" });
  const patch = google.calls.find((c) => c.init.method === "PATCH")!;
  assertEquals(new Headers(patch.init.headers).get("If-Match"), null);
});

Deno.test("承認は仮予約だけ。到着は2回目を書かない", async () => {
  let patches = 0;
  const { provider } = setup((url, init) => {
    if (init.method === "PATCH") patches++;
    const arrived = url.pathname.endsWith("/done");
    return Response.json({
      id: arrived ? "done" : "e",
      etag: '"v"',
      status: "confirmed",
      summary: "田中",
      ...timed,
      extendedProperties: { private: arrived ? { monban_arrived_at: "2026-11-02T05:00:00.000Z" } : {} },
    });
  });
  const error = await assertRejects(() => provider.approve("e"), ProviderError);
  assertEquals(error.status, 409);
  await provider.arrive("done");
  assertEquals(patches, 0);
  await provider.arrive("e");
  assertEquals(patches, 1);
});

Deno.test("見つからない予定は null、更新は 404", async () => {
  const { provider } = setup(() => new Response("", { status: 404 }));
  assertEquals(await provider.get("x"), null);
  const error = await assertRejects(() => provider.cancel("x"), ProviderError);
  assertEquals(error.status, 404);
});

Deno.test("Google の失敗を種類ごとに分ける", async () => {
  const client = (status: number) =>
    new GoogleClient(oauth, "refresh", fakeGoogle(() => new Response("", { status })).fetch);
  await assertRejects(() => client(410).changes("c", "t"), GoogleSyncExpired);
  await assertRejects(() => client(401).changes("c", "t"), GoogleAuthError);
  const server = await assertRejects(() => client(503).changes("c", "t"), GoogleApiError);
  assertEquals(server.transient, true);
  const forbidden = await assertRejects(() => client(403).changes("c", "t"), GoogleApiError);
  assertEquals(forbidden.transient, false);

  const revoked = (() => Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }))) as typeof fetch;
  await assertRejects(() => new GoogleClient(oauth, "refresh", revoked).listCalendars(), GoogleAuthError);
  const offline = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
  const network = await assertRejects(() => new GoogleClient(oauth, "refresh", offline).listCalendars(), GoogleApiError);
  assertEquals(network.transient, true);
});

Deno.test("予約帳とホットペッパーは表、Google と Square はそれぞれの実装を選ぶ", () => {
  const factories = { table: (kind: string) => `table:${kind}`, google: () => "google", square: () => "square" };
  assertEquals(selectProvider("monban", factories), "table:monban");
  assertEquals(selectProvider("hotpepper", factories), "table:hotpepper");
  assertEquals(selectProvider("google_calendar", factories), "google");
  assertEquals(selectProvider("square", factories), "square");
});
