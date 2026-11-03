// deno test supabase/functions/calendar-sync/
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { GoogleClient, type GoogleEvent } from "../_shared/google_calendar.ts";
import type { NewNotification } from "../_shared/notify.ts";
import { baseConnection, fakeGoogle, memoryStore } from "../_shared/testing.ts";
import { BULK_THRESHOLD, classifyChange, syncConnection, syncIfFree } from "./sync.ts";

const now = new Date("2026-11-02T00:00:00.000Z");
const future = {
  start: { dateTime: "2026-11-03T05:00:00.000Z" },
  end: { dateTime: "2026-11-03T06:00:00.000Z" },
};
const created = "2026-11-01T00:00:00.000Z";

function event(id: string, values: Partial<GoogleEvent> = {}): GoogleEvent {
  return { id, etag: `"${id}"`, status: "confirmed", summary: id, created, updated: created, ...future, ...values };
}

function run(handler: (url: URL) => Response, options: Parameters<typeof memoryStore>[0] = {}) {
  const { store, state } = memoryStore({ connection: baseConnection, provider: "google_calendar", ...options });
  const google = fakeGoogle(handler);
  const sent: NewNotification[] = [];
  const deps = {
    store,
    client: () => Promise.resolve(new GoogleClient({ clientId: "i", clientSecret: "s" }, "r", google.fetch)),
    notify: (notification: NewNotification) => {
      sent.push(notification);
      return Promise.resolve();
    },
    now: () => now,
  };
  return {
    state,
    sent,
    google,
    deps,
    store,
    sync: (connection = state.connection!) => syncConnection(connection, deps),
  };
}

Deno.test("差分の分類: 新規、仮、変更、キャンセル、通知しない予定", () => {
  assertEquals(classifyChange(event("a"), now), "reservation_created");
  assertEquals(classifyChange(event("a", { status: "tentative" }), now), "reservation_pending");
  assertEquals(classifyChange(event("a", { updated: "2026-11-01T01:00:00.000Z" }), now), "reservation_updated");
  assertEquals(classifyChange(event("a", { status: "cancelled" }), now), "reservation_cancelled");
  // 時刻の分からない削除は、終日かどうか分からないので個別のキャンセルにしない
  assertEquals(classifyChange({ id: "a", status: "cancelled" }, now), "reservation_updated");
  assertEquals(classifyChange({ id: "a", status: "cancelled", start: { date: "2026-11-03" } }, now), null);
  assertEquals(classifyChange(event("a", { start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }), now), null);
  const past = { start: { dateTime: "2026-11-01T05:00:00.000Z" }, end: { dateTime: "2026-11-01T06:00:00.000Z" } };
  assertEquals(classifyChange(event("a", past), now), null);
});

Deno.test("差分を通知し、次の目印を保存して接続を active にする", async () => {
  const { sync, sent, state, google } = run(() =>
    Response.json({ items: [event("a"), event("b", { status: "cancelled" })], nextSyncToken: "token-2" })
  );
  assertEquals((await sync()).outcome, "synced");
  assertEquals(sent.map((n) => [n.kind, n.dedupe_key]), [
    ["reservation_created", 'google:a:"a"'],
    ["reservation_cancelled", 'google:b:"b"'],
  ]);
  assertEquals(sent[0].actor_user_id, null);
  assertEquals(state.connection?.sync_token, "token-2");
  assertEquals(state.connection?.last_synced_at, now.toISOString());
  const eventsCall = google.calls.find((c) => c.url.pathname.endsWith("/events"))!;
  assertEquals(eventsCall.url.searchParams.get("syncToken"), "token-1");
  assertEquals(eventsCall.url.searchParams.get("singleEvents"), "true");
});

const marked = (id: string, writeId: string, values: Partial<GoogleEvent> = {}) =>
  event(id, { extendedProperties: { private: { monban_write: writeId } }, ...values });

Deno.test("MONBAN が書いた印が記録にあれば通知せず、記録を消す", async () => {
  const { sync, sent, state } = run(
    () => Response.json({ items: [marked("mine", "w1"), event("other")], nextSyncToken: "token-2" }),
    { own: [{ write_id: "w1", event_id: null }] },
  );
  assertEquals((await sync()).notified, 1);
  assertEquals(sent.map((n) => n.data?.reservation_id), ["other"]);
  assertEquals(state.own, []);
});

Deno.test("印が記録になければ通知する（店が Google で直接変えると、古い印が残る）", async () => {
  const { sync, sent } = run(() => Response.json({ items: [marked("mine", "w1")], nextSyncToken: "token-2" }));
  assertEquals((await sync()).notified, 1);
  assertEquals(sent.map((n) => n.data?.reservation_id), ["mine"]);
});

Deno.test("同じ予定を続けて読むと、2回目の店の変更は通知する", async () => {
  let round = 0;
  const { sync, sent } = run(
    () => Response.json({ items: [marked("mine", "w1")], nextSyncToken: `token-${++round + 1}` }),
    { own: [{ write_id: "w1", event_id: "mine" }] },
  );
  assertEquals((await sync()).notified, 0);
  assertEquals((await sync()).notified, 1);
  assertEquals(sent.length, 1);
});

Deno.test("id しか返らない削除は、予定の id で自分の書き込みと分かる", async () => {
  const { sync, sent, state } = run(
    () => Response.json({ items: [{ id: "mine", status: "cancelled" }, { id: "other", etag: '"o"', status: "cancelled" }], nextSyncToken: "token-2" }),
    { own: [{ write_id: "w1", event_id: "mine" }] },
  );
  assertEquals((await sync()).notified, 1);
  assertEquals(sent[0].title, "予約先の予定が削除されました");
  assertEquals(state.own, []);
});

Deno.test("印のない変更は、同じ予定の記録があっても通知する", async () => {
  const { sync, sent, state } = run(
    () => Response.json({ items: [event("mine")], nextSyncToken: "token-2" }),
    { own: [{ write_id: "w1", event_id: "mine" }] },
  );
  assertEquals((await sync()).notified, 1);
  assertEquals(sent.length, 1);
  assertEquals(state.own.length, 1);
});

Deno.test("通知に失敗したら記録を残し、読み直しても自分の変更と分かる", async () => {
  const { store, state } = memoryStore({
    connection: baseConnection,
    provider: "google_calendar",
    own: [{ write_id: "w1", event_id: null }],
  });
  const google = fakeGoogle(() => Response.json({ items: [marked("mine", "w1"), event("other")], nextSyncToken: "token-2" }));
  const result = await syncConnection(state.connection!, {
    store,
    client: () => Promise.resolve(new GoogleClient({ clientId: "i", clientSecret: "s" }, "r", google.fetch)),
    notify: () => Promise.reject(new Error("db down")),
    now: () => now,
  });
  assertEquals(result.outcome, "failed");
  assertEquals(state.own.length, 1);
  assertEquals(state.connection?.sync_token, "token-1");
});

Deno.test("権利が取れなければ読まずに飛ばす", async () => {
  const { deps, state, google } = run(() => Response.json({ items: [], nextSyncToken: "token-2" }), { leased: true });
  const result = await syncIfFree(state.connection!, deps);
  assertEquals(result.outcome, "skipped");
  assertEquals(google.calls.length, 0);
  assertEquals(state.leaseReleases, 0);
});

Deno.test("権利を取ったら読み直した最新の目印で読み、終わったら解放する", async () => {
  const { deps, state, google } = run(() => Response.json({ items: [], nextSyncToken: "token-3" }));
  // 一覧を読んだあとに、前の回が目印を進めた
  const stale = { ...state.connection!, sync_token: "stale" };
  state.connection = { ...state.connection!, sync_token: "token-2" };
  assertEquals((await syncIfFree(stale, deps)).outcome, "synced");
  const eventsCall = google.calls.find((c) => c.url.pathname.endsWith("/events"))!;
  assertEquals(eventsCall.url.searchParams.get("syncToken"), "token-2");
  assertEquals(state.connection?.sync_token, "token-3");
  assertEquals([state.leased, state.leaseReleases], [false, 1]);
});

Deno.test("読み取りに失敗しても権利を解放する", async () => {
  const { deps, state } = run(() => new Response("boom", { status: 500 }));
  assertEquals((await syncIfFree(state.connection!, deps)).outcome, "failed");
  assertEquals([state.leased, state.leaseReleases], [false, 1]);
});

Deno.test("権利の取得に失敗しても、その接続だけの失敗にする", async () => {
  const { deps, state, store } = run(() => Response.json({ items: [], nextSyncToken: "t" }));
  store.acquireSyncLease = () => Promise.reject(new Error("db down"));
  const result = await syncIfFree(state.connection!, deps);
  assertEquals([result.outcome, result.error], ["failed", "db down"]);
  assertEquals(state.leaseReleases, 0);
});

Deno.test("差分が多いときは1件にまとめる", async () => {
  const many = Array.from({ length: BULK_THRESHOLD + 1 }, (_, i) => event(`e${i}`));
  const { sync, sent } = run(() => Response.json({ items: many, nextSyncToken: "token-2" }));
  assertEquals((await sync()).notified, 1);
  assertEquals(sent[0].kind, "reservation_updated");
  // 読み始めの目印から作るので、読み直しても同じキーになる
  assertEquals(sent[0].dedupe_key, "google:bulk:token-1");
  assertEquals(sent[0].body, `${BULK_THRESHOLD + 1} 件（11月3日（火）14:00 から）`);
});

Deno.test("時刻の分からない削除は、予定が消えたことだけを知らせる", async () => {
  const { sync, sent } = run(() => Response.json({ items: [{ id: "gone", etag: '"gone"', status: "cancelled" }], nextSyncToken: "token-2" }));
  await sync();
  assertEquals(sent.map((n) => [n.kind, n.title, n.dedupe_key]), [["reservation_updated", "予約先の予定が削除されました", 'google:gone:"gone"']]);
  assertEquals(sent[0].data, {});
});

Deno.test("目印の保存では、変える項目だけを送る", async () => {
  const { sync, state } = run(() => Response.json({ items: [], nextSyncToken: "token-2" }));
  await sync();
  assertEquals(Object.keys(state.saved.at(-1)!).sort(), ["last_error", "last_synced_at", "status", "sync_token"]);
  assertEquals(state.connection?.refresh_token_encrypted, baseConnection.refresh_token_encrypted);
});

Deno.test("403 のレート制限は一時的な失敗として扱う", async () => {
  const limited = () =>
    Response.json({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }, { status: 403 });
  const recent = { ...baseConnection, last_synced_at: "2026-11-01T23:55:00.000Z" };
  const first = run(limited, { connection: recent });
  await first.sync();
  assertEquals([first.state.connection?.status, first.sent.length], ["active", 0]);

  const denied = run(() => Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: 403 }), { connection: recent });
  await denied.sync();
  assertEquals([denied.state.connection?.status, denied.sent.length], ["error", 1]);
});

Deno.test("境界の件数まではまとめない", async () => {
  const many = Array.from({ length: BULK_THRESHOLD }, (_, i) => event(`e${i}`));
  const { sync, sent } = run(() => Response.json({ items: many, nextSyncToken: "token-2" }));
  await sync();
  assertEquals(sent.length, BULK_THRESHOLD);
});

Deno.test("差分が 410 を返したら起点を取り直し、その回は通知しない", async () => {
  const { sync, sent, state } = run((url) =>
    url.searchParams.has("syncToken")
      ? new Response("", { status: 410 })
      : Response.json({ items: [event("old")], nextSyncToken: "fresh" })
  );
  const result = await sync();
  assertEquals([result.outcome, result.notified, sent.length], ["baseline", 0, 0]);
  assertEquals(state.connection?.sync_token, "fresh");
});

Deno.test("目印がなければ起点を取るだけで通知しない", async () => {
  const { sync, sent, google } = run(() => Response.json({ items: [event("old")], nextSyncToken: "first" }), {
    connection: { ...baseConnection, sync_token: null },
  });
  assertEquals((await sync()).outcome, "baseline");
  assertEquals(sent.length, 0);
  const eventsCall = google.calls.find((c) => c.url.pathname.endsWith("/events"))!;
  assertEquals(eventsCall.url.searchParams.get("timeMin"), now.toISOString());
});

Deno.test("認証の失敗はすぐ error にして1回だけ通知し、目印は進めない", async () => {
  const { sync, sent, state } = run(() => new Response("", { status: 401 }));
  assertEquals((await sync()).outcome, "failed");
  assertEquals(state.connection?.status, "error");
  assertEquals(state.connection?.sync_token, "token-1");
  assertEquals(sent.map((n) => n.kind), ["calendar_sync_failed"]);
  await sync();
  assertEquals(sent.length, 1);
});

Deno.test("一時的な失敗は 10 分までは通知せず、続いたら通知する", async () => {
  const recent = { ...baseConnection, last_synced_at: "2026-11-01T23:55:00.000Z" };
  const first = run(() => new Response("", { status: 503 }), { connection: recent });
  await first.sync();
  assertEquals([first.state.connection?.status, first.sent.length], ["active", 0]);

  const stale = { ...baseConnection, last_synced_at: "2026-11-01T23:40:00.000Z" };
  const later = run(() => new Response("", { status: 503 }), { connection: stale });
  await later.sync();
  assertEquals([later.state.connection?.status, later.sent.length], ["error", 1]);
});

Deno.test("読めるようになったら active に戻り、次の失敗でまた通知できる", async () => {
  const { sync, state } = run(() => Response.json({ items: [], nextSyncToken: "token-2" }), {
    connection: { ...baseConnection, status: "error", last_error: "前の失敗" },
  });
  await sync();
  assertEquals([state.connection?.status, state.connection?.last_error], ["active", null]);
});

Deno.test("通知に失敗したら目印を進めず、次の回に送り直す", async () => {
  const { store, state } = memoryStore({ connection: baseConnection, provider: "google_calendar" });
  const google = fakeGoogle(() => Response.json({ items: [event("a")], nextSyncToken: "token-2" }));
  const result = await syncConnection(baseConnection, {
    store,
    client: () => Promise.resolve(new GoogleClient({ clientId: "i", clientSecret: "s" }, "r", google.fetch)),
    notify: () => Promise.reject(new Error("db down")),
    now: () => now,
  });
  assertEquals(result.outcome, "failed");
  assertEquals(state.connection?.sync_token, "token-1");
});
