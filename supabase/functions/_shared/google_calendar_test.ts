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
  const own: string[] = [];
  const provider = new GoogleProvider(new GoogleClient(oauth, "refresh", google.fetch), "cal@example.com", (id, etag) => {
    own.push(`${id}:${etag}`);
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

Deno.test("書いた版を記録し、通知のキーは google:<id>:<etag> になる", async () => {
  const { provider, own } = setup((_, init) => {
    assertEquals(JSON.parse(String(init.body)).status, "tentative");
    return Response.json({ id: "new", etag: '"v1"', status: "tentative", summary: "田中様", ...timed });
  });
  const write = await provider.create({
    customer_name: "田中",
    customer_phone: null,
    service_name: null,
    starts_at: "2026-11-02T05:00:00.000Z",
    ends_at: "2026-11-02T06:30:00.000Z",
    note: null,
    status: "pending",
    source: "ai",
    visit_id: null,
  });
  assertEquals(own, ['new:"v1"']);
  assertEquals(write.dedupeKey("reservation_pending"), 'google:new:"v1"');
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
