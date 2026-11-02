import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import type { IntentContext, IntentParser, ParsedIntent } from "../_shared/assistant/intent_parser.ts";
import { ProviderError, type ReservationProvider } from "../_shared/reservation.ts";
import { type AssistantDeps, handleAssistantRequest } from "./handler.ts";

const NOW = new Date("2026-11-02T04:20:00.000Z");

function request(body: unknown, method = "POST", path = "/functions/v1/assistant/parse") {
  return new Request(`https://example.test${path}`, {
    method,
    ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function deps(overrides: Partial<AssistantDeps> = {}) {
  const parsed: { text: string; context: IntentContext }[] = [];
  const writes: string[] = [];
  const parser: IntentParser = {
    parse(text, context) {
      parsed.push({ text, context });
      return Promise.resolve({
        action: "add",
        customer_name: "田中",
        date: "2026-11-05",
        start_time: "14:00",
        service_name: "ジェルネイル",
      } as ParsedIntent);
    },
  };
  const write = (name: string) => () => {
    writes.push(name);
    throw new Error("案を作るだけで書き込まない");
  };
  const provider = {
    kind: "monban",
    list: () => Promise.resolve([]),
    create: write("create"),
    update: write("update"),
    approve: write("approve"),
    cancel: write("cancel"),
    arrive: write("arrive"),
  } as unknown as ReservationProvider;
  const all: AssistantDeps = {
    authenticate: () => Promise.resolve({ userId: "u1", householdId: "h1" }),
    parser,
    providerFor: () => Promise.resolve(provider),
    shopFor: () => Promise.resolve({ services: [{ name: "ジェルネイル", duration_minutes: 90 }], hours: [] }),
    now: () => NOW,
    ...overrides,
  };
  return { deps: all, parsed, writes };
}

Deno.test("文を案に変え、書き込まない", async () => {
  const { deps: d, parsed, writes } = deps();
  const res = await handleAssistantRequest(request({ text: " 木曜の14時に田中さん " }), d);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    proposal: {
      type: "add_reservation",
      customer_name: "田中",
      customer_phone: null,
      service_name: "ジェルネイル",
      starts_at: "2026-11-05T05:00:00.000Z",
      ends_at: "2026-11-05T06:30:00.000Z",
      note: null,
      warnings: [],
    },
  });
  assertEquals(parsed[0].text, "木曜の14時に田中さん");
  assertEquals(parsed[0].context.today, "2026-11-02");
  assertEquals(parsed[0].context.services, [{ name: "ジェルネイル", duration_minutes: 90 }]);
  assertEquals(writes, []);
});

Deno.test("未ログインは 401、グループなしは 403 で、解析器を呼ばない", async () => {
  for (const [auth, status] of [[null, 401], ["forbidden", 403]] as const) {
    const { deps: d, parsed } = deps({ authenticate: () => Promise.resolve(auth) });
    assertEquals((await handleAssistantRequest(request({ text: "x" }), d)).status, status);
    assertEquals(parsed.length, 0);
  }
});

Deno.test("文の検証", async () => {
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 1 }, { text: "あ".repeat(201) }, "not json", []]) {
    const { deps: d, parsed } = deps();
    const res = await handleAssistantRequest(request(body), d);
    await res.body?.cancel();
    assertEquals(res.status, 400);
    assertEquals(parsed.length, 0);
  }
  const { deps: d, parsed } = deps();
  const res = await handleAssistantRequest(request({ text: "あ".repeat(200) }), d);
  await res.body?.cancel();
  assertEquals([res.status, parsed.length], [200, 1]);
});

Deno.test("解析器の設定がなければ 503", async () => {
  const { deps: d } = deps({ parser: null });
  const res = await handleAssistantRequest(request({ text: "x" }), d);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "assistant_unavailable");
});

Deno.test("解析器に届かなければ 503", async () => {
  const parser: IntentParser = {
    parse: () => Promise.reject(new ProviderError(503, "届かない", "assistant_unavailable")),
  };
  const res = await handleAssistantRequest(request({ text: "x" }), deps({ parser }).deps);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "assistant_unavailable");
});

Deno.test("パスとメソッド", async () => {
  const { deps: d } = deps();
  const notFound = await handleAssistantRequest(request({ text: "x" }, "POST", "/functions/v1/assistant/other"), d);
  assertEquals(notFound.status, 404);
  await notFound.body?.cancel();
  const wrong = await handleAssistantRequest(request(null, "GET"), d);
  assertEquals(wrong.status, 405);
  await wrong.body?.cancel();
});

Deno.test("知らない失敗はそのまま投げる", async () => {
  const parser: IntentParser = { parse: () => Promise.reject(new Error("bug")) };
  await assertRejects(() => handleAssistantRequest(request({ text: "x" }), deps({ parser }).deps), Error, "bug");
});
