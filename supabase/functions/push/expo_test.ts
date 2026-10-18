// deno test supabase/functions/push/expo_test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { buildMessages, ExpoError, sendBatch, ticketOutcome } from "./expo.ts";

const notice = { kind: "chime" as const, title: "来客があります", body: "10:32 にチャイムが鳴りました" };

// 決めた順に応答を返す fetch。呼ばれた回数を数える
function fakeFetch(responses: (Response | Error)[]) {
  const calls: RequestInit[] = [];
  const fn = (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const next = responses.shift();
    if (!next) throw new Error("想定より多く呼ばれた");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch: fn as typeof fetch, calls };
}

const ok = () => Response.json({ data: [{ status: "ok", id: "ticket-1" }] });
const noSleep = { sleep: () => Promise.resolve() };

Deno.test("通知は来客時も対応後も優先度 high で、data に visit_id と種類を入れる", () => {
  assertEquals(buildMessages(["ExponentPushToken[a]"], notice, "v1"), [{
    to: "ExponentPushToken[a]",
    title: "来客があります",
    body: "10:32 にチャイムが鳴りました",
    sound: "default",
    priority: "high",
    data: { visit_id: "v1", kind: "chime" },
  }]);
  const ended = buildMessages(["t"], { ...notice, kind: "ended" }, "v1")[0];
  assertEquals([ended.priority, ended.data.kind], ["high", "ended"]);
});

Deno.test("503 のあと成功すれば、2回目の ticket を返す", async () => {
  const f = fakeFetch([new Response("unavailable", { status: 503 }), ok()]);
  const tickets = await sendBatch([{}], { fetch: f.fetch, ...noSleep });
  assertEquals(tickets, [{ status: "ok", id: "ticket-1" }]);
  assertEquals(f.calls.length, 2);
});

Deno.test("ネットワークの失敗と 429 も試し直す", async () => {
  const f = fakeFetch([new TypeError("connection reset"), new Response("", { status: 429 }), ok()]);
  await sendBatch([{}], { fetch: f.fetch, ...noSleep });
  assertEquals(f.calls.length, 3);
});

Deno.test("3回とも 5xx なら、送り直せる失敗として投げる", async () => {
  const f = fakeFetch([500, 502, 503].map((s) => new Response("", { status: s })));
  const error = await assertRejects(() => sendBatch([{}], { fetch: f.fetch, ...noSleep }), ExpoError);
  assertEquals([error.retryable, f.calls.length], [true, 3]);
});

Deno.test("認証の失敗などの 4xx は試し直さず、送り直せない失敗として投げる", async () => {
  const f = fakeFetch([Response.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 })]);
  const error = await assertRejects(() => sendBatch([{}], { fetch: f.fetch, ...noSleep }), ExpoError);
  assertEquals([error.retryable, f.calls.length], [false, 1]);
});

Deno.test("アクセストークンがあれば Authorization に付ける", async () => {
  const f = fakeFetch([ok()]);
  await sendBatch([{}], { fetch: f.fetch, accessToken: "expo-token", ...noSleep });
  assertEquals((f.calls[0].headers as Record<string, string>)["Authorization"], "Bearer expo-token");
});

Deno.test("ticket の結果: 受付、送り直し（MessageRateExceeded）、あきらめ", () => {
  assertEquals(ticketOutcome({ status: "ok", id: "x" }), { status: "accepted" });
  assertEquals(
    ticketOutcome({ status: "error", message: "slow down", details: { error: "MessageRateExceeded" } }).status,
    "retry",
  );
  assertEquals(
    ticketOutcome({ status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }),
    { status: "failed", error: "DeviceNotRegistered: not registered" },
  );
  assertEquals(ticketOutcome(undefined).status, "retry");
});

Deno.test("malformed successful Expo responses are permanent failures without retries", async () => {
  for (const response of [
    new Response("not JSON"),
    Response.json(null),
    Response.json({ data: {} }),
    Response.json({ errors: [{ code: "INVALID_REQUEST" }] }),
  ]) {
    const f = fakeFetch([response]);
    const error = await assertRejects(() => sendBatch([{}], { fetch: f.fetch, ...noSleep }), ExpoError);
    assertEquals(error.retryable, false);
    assertEquals(f.calls.length, 1);
  }
});

Deno.test("retry exhaustion preserves delays and the last network failure", async () => {
  const f = fakeFetch([new Error("first"), new Error("second"), new Error("last")]);
  const delays: number[] = [];
  const error = await assertRejects(() => sendBatch([{}], {
    fetch: f.fetch,
    sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
  }), ExpoError);
  assertEquals(delays, [1000, 3000]);
  assertEquals(error.message, "Expo network error: last");
  assertEquals(error.retryable, true);
  assertEquals(f.calls.length, 3);
});

Deno.test("a permanent response after a temporary failure stops remaining retries", async () => {
  const f = fakeFetch([new Response("", { status: 503 }), Response.json({ errors: ["unauthorized"] }, { status: 401 })]);
  const delays: number[] = [];
  const error = await assertRejects(() => sendBatch([{}], {
    fetch: f.fetch,
    sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
  }), ExpoError);
  assertEquals(delays, [1000]);
  assertEquals(error.message, 'Expo HTTP 401 ["unauthorized"]');
  assertEquals(error.retryable, false);
  assertEquals(f.calls.length, 2);
});

Deno.test("no configured retries returns the first transient failure", async () => {
  const f = fakeFetch([new Response("", { status: 429 })]);
  const error = await assertRejects(() => sendBatch([{}], { fetch: f.fetch, delaysMs: [] }), ExpoError);
  assertEquals(error.message, "Expo HTTP 429");
  assertEquals(error.retryable, true);
  assertEquals(f.calls.length, 1);
});
