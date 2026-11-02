// deno test --allow-env supabase/functions/_shared/
import { assertEquals } from "jsr:@std/assert@1.0.19";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { createCalendarStore } from "./calendar_store.ts";

// 呼ばれた操作を記録する、Supabase のクエリの偽物
function fakeAdmin(rows: unknown[] = []) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const admin = {
    from(table: string) {
      const query = {
        then(resolve: (value: { data: unknown; error: null }) => void) {
          resolve({ data: rows, error: null });
        },
      } as Record<string, unknown>;
      for (const method of ["select", "update", "upsert", "insert", "delete", "eq", "in", "not"]) {
        query[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return query;
        };
      }
      return query;
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

Deno.test("部分更新は upsert でなく update にする（upsert は NOT NULL の列がないと失敗する）", async () => {
  const { admin, calls } = fakeAdmin();
  const store = createCalendarStore(admin);

  await store.updateConnection("h1", { sync_token: "t" });
  assertEquals(calls.some((c) => c.method === "upsert"), false);
  assertEquals(calls.find((c) => c.method === "update")?.table, "calendar_connections");
  assertEquals(calls.find((c) => c.method === "eq")?.args, ["household_id", "h1"]);

  calls.length = 0;
  await store.updateSquareConnection("h1", { status: "error", last_error: "x" });
  assertEquals(calls.some((c) => c.method === "upsert"), false);
  assertEquals(calls.find((c) => c.method === "update")?.table, "square_connections");
});

Deno.test("自分の書き込みの照会は URL が長くならないように分ける", async () => {
  const { admin, calls } = fakeAdmin([{ event_id: "e0", etag: '"1"' }]);
  const store = createCalendarStore(admin);
  const own = await store.ownEtags("h1", Array.from({ length: 120 }, (_, i) => `e${i}`));
  const batches = calls.filter((c) => c.method === "in").map((c) => (c.args[1] as string[]).length);
  assertEquals(batches, [50, 50, 20]);
  assertEquals(own.has('e0:"1"'), true);

  calls.length = 0;
  assertEquals((await store.ownEtags("h1", [])).size, 0);
  assertEquals(calls.length, 0);
});

Deno.test("外部の予約の到着の照会も分ける", async () => {
  const { admin, calls } = fakeAdmin([{ external_id: "b0", arrived_at: "2026-11-02T00:00:00Z" }]);
  const store = createCalendarStore(admin);
  const arrivals = await store.externalArrivals("h1", "square", Array.from({ length: 60 }, (_, i) => `b${i}`));
  assertEquals(calls.filter((c) => c.method === "in").map((c) => (c.args[1] as string[]).length), [50, 10]);
  assertEquals(arrivals.get("b0"), "2026-11-02T00:00:00.000Z");
});
