// deno test --allow-env supabase/functions/door/
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { type DoorConfig, type DoorDeps, doorConfigFromEnv, handleDoorRequest } from "./handler.ts";

const config: DoorConfig = { baseUrl: "https://door.example.test", apiKey: "door-key", allowedHouseholdIds: ["h1"] };

type Call = { url: string; method: string; authorization: string | null; body: unknown };

function setup(
  options: {
    member?: "forbidden" | null | { userId: string; householdId: string };
    config?: DoorConfig | null;
    upstream?: () => Response | Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  const deps: DoorDeps = {
    authenticate: () => Promise.resolve(options.member === undefined ? { userId: "u1", householdId: "h1" } : options.member),
    config: options.config === undefined ? config : options.config,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: String(init?.method),
        authorization: headers.get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return await (options.upstream?.() ?? Response.json({ ok: true }));
    },
  };
  return { deps, calls };
}

const request = (method: string, path: string, body?: unknown) =>
  new Request(`https://example.test/functions/v1/door${path}`, {
    method,
    headers: { authorization: "Bearer jwt", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

Deno.test("未ログインとグループ外は中継しない", async () => {
  for (const [member, status] of [[null, 401], ["forbidden", 403]] as const) {
    const { deps, calls } = setup({ member });
    assertEquals((await handleDoorRequest(request("GET", "/status"), deps)).status, status);
    assertEquals(calls.length, 0);
  }
});

Deno.test("許可していないグループと未設定は中継しない", async () => {
  const other = setup({ member: { userId: "u2", householdId: "h2" } });
  assertEquals((await handleDoorRequest(request("GET", "/status"), other.deps)).status, 403);
  assertEquals(other.calls.length, 0);

  const unconfigured = setup({ config: null });
  const response = await handleDoorRequest(request("GET", "/status"), unconfigured.deps);
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, "door_not_configured");
});

Deno.test("知らない経路は 404、メソッド違いは 405。上流は呼ばない", async () => {
  const { deps, calls } = setup();
  assertEquals((await handleDoorRequest(request("GET", "/control/mode"), deps)).status, 404);
  assertEquals((await handleDoorRequest(request("DELETE", "/reception/settings"), deps)).status, 405);
  assertEquals(calls.length, 0);
});

Deno.test("経路ごとに上流の API へ鍵を付けて中継し、返事をそのまま返す", async () => {
  const expected: [string, string, string][] = [
    ["GET", "/status", "/api/status"],
    ["GET", "/reception/settings", "/api/reception/settings"],
    ["GET", "/reception/visits", "/api/reception/visits"],
    ["GET", "/google-calendar/status", "/api/integrations/google-calendar/status"],
    ["POST", "/google-calendar/start", "/api/integrations/google-calendar/start"],
    ["POST", "/google-calendar/disconnect", "/api/integrations/google-calendar/disconnect"],
    ["GET", "/google-calendar/calendars", "/api/integrations/google-calendar/calendars"],
    ["GET", "/google-calendar/events", "/api/integrations/google-calendar/events"],
  ];
  for (const [method, path, upstream] of expected) {
    const { deps, calls } = setup({ upstream: () => Response.json([{ id: "a" }]) });
    const response = await handleDoorRequest(request(method, path), deps);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), [{ id: "a" }]);
    assertEquals(calls, [{ url: `https://door.example.test${upstream}`, method, authorization: "Bearer door-key", body: undefined }]);
  }
});

Deno.test("案内文は前後の空白を除き、1〜300 字だけ通す。余計な項目は渡さない", async () => {
  const { deps, calls } = setup();
  const saved = await handleDoorRequest(request("PUT", "/reception/settings", { text: "  お待ちください  ", extra: "x" }), deps);
  assertEquals(saved.status, 200);
  assertEquals(calls[0].body, { text: "お待ちください" });

  for (const text of ["", "   ", "あ".repeat(301), 1, undefined]) {
    const rejected = setup();
    assertEquals((await handleDoorRequest(request("PUT", "/reception/settings", { text }), rejected.deps)).status, 400);
    assertEquals(rejected.calls.length, 0);
  }
  const notJson = setup();
  const bad = new Request("https://example.test/functions/v1/door/reception/settings", { method: "PUT", body: "x" });
  assertEquals((await handleDoorRequest(bad, notJson.deps)).status, 400);
  assertEquals(notJson.calls.length, 0);
});

Deno.test("カレンダーの選択は calendar_id だけを渡す", async () => {
  const { deps, calls } = setup();
  assertEquals((await handleDoorRequest(request("POST", "/google-calendar/select", { calendar_id: "cal@example.com", x: 1 }), deps)).status, 200);
  assertEquals(calls[0].body, { calendar_id: "cal@example.com" });
  for (const calendar_id of ["", "a".repeat(1025), 3, undefined]) {
    const rejected = setup();
    assertEquals((await handleDoorRequest(request("POST", "/google-calendar/select", { calendar_id }), rejected.deps)).status, 400);
    assertEquals(rejected.calls.length, 0);
  }
});

Deno.test("上流の失敗をアプリのログアウトと混ぜず、内部の詳細は返さない", async () => {
  const cases: [Response, number, string][] = [
    [new Response("Unauthorized", { status: 401 }), 502, "door_unauthorized"],
    [Response.json({ detail: "選択できないカレンダーです" }, { status: 400 }), 400, "door_rejected"],
    [Response.json({ detail: "取得失敗" }, { status: 503 }), 503, "door_unavailable"],
    [new Response("boom", { status: 500 }), 502, "door_rejected"],
    [new Response("not json", { status: 200 }), 502, "door_unavailable"],
  ];
  for (const [upstream, status, code] of cases) {
    const { deps } = setup({ upstream: () => upstream });
    const response = await handleDoorRequest(request("GET", "/reception/visits"), deps);
    assertEquals(response.status, status);
    assertEquals((await response.json()).code, code);
  }
  const rejected = setup({ upstream: () => Response.json({ detail: "選択できないカレンダーです" }, { status: 400 }) });
  assertEquals((await (await handleDoorRequest(request("GET", "/status"), rejected.deps)).json()).error, "選択できないカレンダーです");

  const down = setup({ upstream: () => Promise.reject(new TypeError("connection refused")) });
  const response = await handleDoorRequest(request("GET", "/status"), down.deps);
  assertEquals(response.status, 502);
  assertEquals((await response.json()).code, "door_unavailable");
});

Deno.test("環境変数は 3 つそろったときだけ有効", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];
  const all: Record<string, string> = {
    DOOR_API_BASE_URL: "https://door.example.test/",
    DOOR_API_KEY: " k ",
    DOOR_ALLOWED_HOUSEHOLD_IDS: "h1, h2,,",
  };
  assertEquals(doorConfigFromEnv(env(all)), { baseUrl: "https://door.example.test", apiKey: "k", allowedHouseholdIds: ["h1", "h2"] });
  for (const missing of Object.keys(all)) {
    const rest = Object.fromEntries(Object.entries(all).filter(([name]) => name !== missing));
    assertEquals(doorConfigFromEnv(env(rest)), null);
  }
  assertEquals(doorConfigFromEnv(env({ ...all, DOOR_ALLOWED_HOUSEHOLD_IDS: " , " })), null);
});
