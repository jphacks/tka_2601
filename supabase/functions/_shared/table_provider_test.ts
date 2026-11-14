// deno test supabase/functions/_shared/
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { ProviderError } from "./reservation.ts";
import { TableProvider } from "./table_provider.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const row = (status: string, arrived_at: string | null = null) => ({
  id: ID,
  customer_name: "田中",
  customer_phone: null,
  service_name: null,
  starts_at: "2026-11-02T05:00:00Z",
  ends_at: "2026-11-02T06:00:00Z",
  status,
  source: "ai",
  note: null,
  arrived_at,
  visit_id: null,
  updated_at: "2026-11-02T00:00:00Z",
});

// reads は読み取りの結果を順に返し、updated は更新の結果を返す（条件に合わなければ null）
function fakeAdmin(
  reads: unknown[],
  updated: unknown,
  rpc: { data?: unknown; error?: unknown } = {},
  inserted: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const filters: unknown[][] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const admin = {
    from() {
      let updating = false;
      const query: Record<string, unknown> = {
        select: () => query,
        update: () => {
          updating = true;
          return query;
        },
        insert: () => {
          return { select: () => ({ single: () => Promise.resolve(inserted) }) };
        },
        eq: (...args: unknown[]) => {
          if (updating) filters.push(["eq", ...args]);
          return query;
        },
        neq: (...args: unknown[]) => {
          if (updating) filters.push(["neq", ...args]);
          return query;
        },
        maybeSingle: () => Promise.resolve({ data: updating ? updated : reads.shift() ?? null, error: null }),
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return { select: () => ({ single: () => Promise.resolve({ data: rpc.data ?? null, error: rpc.error ?? null }) }) };
    },
  } as unknown as SupabaseClient;
  return { admin, filters, rpcCalls };
}

const provider = (admin: SupabaseClient, blocking?: ("pending" | "confirmed" | "cancelled")[]) =>
  new TableProvider(admin, "h1", "monban", blocking);

const assertConflict = (run: () => Promise<unknown>) => assertRejects(run, ProviderError, "");

Deno.test("承認は仮予約のときだけ書く。読んだあとにキャンセルされていたら 409", async () => {
  const ok = fakeAdmin([row("pending")], row("confirmed"));
  assertEquals((await provider(ok.admin).approve(ID)).reservation.status, "confirmed");
  assertEquals(ok.filters.at(-1), ["eq", "status", "pending"]);

  const raced = fakeAdmin([row("pending")], null);
  await assertConflict(() => provider(raced.admin).approve(ID));
});

Deno.test("キャンセルと変更と到着は、キャンセル済みの行を書き換えない", async () => {
  const cancel = fakeAdmin([row("confirmed")], row("cancelled"));
  await provider(cancel.admin).cancel(ID);
  assertEquals(cancel.filters.at(-1), ["neq", "status", "cancelled"]);

  // 読んだあとに別の操作でキャンセルされていたら、書かずに今の行を返す
  const racedCancel = fakeAdmin([row("confirmed"), row("cancelled")], null);
  assertEquals((await provider(racedCancel.admin).cancel(ID)).reservation.status, "cancelled");

  const racedUpdate = fakeAdmin([row("confirmed")], null);
  await assertConflict(() => provider(racedUpdate.admin).update(ID, { note: "x" }));

  const racedArrive = fakeAdmin([row("confirmed")], null);
  await assertConflict(() => provider(racedArrive.admin).arrive(ID));
});

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

Deno.test("重なりの確認は DB の関数に任せ、PT409 を reservation_overlap にする", async () => {
  const free = fakeAdmin([], null, { data: row("pending") });
  assertEquals((await provider(free.admin).createIfFree(input)).reservation.id, ID);
  assertEquals(free.rpcCalls[0].name, "reservation_create_if_free");
  assertEquals(free.rpcCalls[0].args.p_blocking_statuses, ["pending", "confirmed"]);

  const blocked = fakeAdmin([], null, { error: { code: "PT409", message: "重なり" } });
  const error = await assertRejects(() => provider(blocked.admin).createIfFree(input), ProviderError) as ProviderError;
  assertEquals([error.status, error.code], [409, "reservation_overlap"]);
});

Deno.test("Square の予約帳は確定を重なりに数えない", async () => {
  const { admin, rpcCalls } = fakeAdmin([], null, { data: row("pending") });
  await provider(admin, ["pending"]).createIfFree(input);
  assertEquals(rpcCalls[0].args.p_blocking_statuses, ["pending"]);
});

const expectedTimes = { starts_at: "2026-11-02T05:00:00.000Z", ends_at: "2026-11-02T06:00:00.000Z" };

Deno.test("見ていた時刻と同じなら、その時刻を条件に書く（形式の違いは同じ時刻として比べる）", async () => {
  const { admin, filters } = fakeAdmin([row("confirmed")], row("confirmed"));
  await provider(admin).update(ID, { note: "メモ" }, expectedTimes);
  assertEquals(filters.some((f) => f[1] === "starts_at" && f[2] === "2026-11-02T05:00:00Z"), true);
  assertEquals(filters.some((f) => f[1] === "ends_at" && f[2] === "2026-11-02T06:00:00Z"), true);
});

Deno.test("見ていた時刻を渡さなければ、時刻を条件にしない", async () => {
  const { admin, filters } = fakeAdmin([row("confirmed")], row("confirmed"));
  await provider(admin).update(ID, { note: "メモ" });
  assertEquals(filters.some((f) => f[1] === "starts_at"), false);
});

Deno.test("見ていた時刻と違えば 409（reservation_changed）で書かない", async () => {
  const { admin, filters } = fakeAdmin([row("confirmed")], row("confirmed"));
  const error = await assertRejects(
    () => provider(admin).update(ID, { note: "メモ" }, { starts_at: "2026-11-02T04:00:00.000Z" }),
    ProviderError,
  );
  assertEquals([error.status, error.code], [409, "reservation_changed"]);
  assertEquals(filters.length, 0);
});

Deno.test("読んでから書くまでに変わったら reservation_changed、キャンセルされたらその旨を返す", async () => {
  const changed = fakeAdmin([row("confirmed"), row("confirmed")], null);
  const error = await assertRejects(() => provider(changed.admin).update(ID, { note: "メモ" }, expectedTimes), ProviderError);
  assertEquals(error.code, "reservation_changed");

  const cancelled = fakeAdmin([row("confirmed"), row("cancelled")], null);
  const other = await assertRejects(() => provider(cancelled.admin).update(ID, { note: "メモ" }, expectedTimes), ProviderError);
  assertEquals([other.status, other.code], [409, undefined]);
});

const newReservation = {
  customer_name: "田中",
  customer_phone: null,
  service_name: null,
  starts_at: "2026-11-02T05:00:00Z",
  ends_at: "2026-11-02T06:00:00Z",
  note: null,
  status: "confirmed" as const,
  source: "app" as const,
  visit_id: null,
};

Deno.test("同じ冪等キーの予約があれば既存を返す", async () => {
  const { admin } = fakeAdmin([row("confirmed")], null, {}, { data: null, error: { code: "23505", message: "duplicate" } });
  const write = await provider(admin).create({ ...newReservation, idempotency_key: "Key-12345" });
  assertEquals(write.existed, true);
  assertEquals(write.reservation.id, ID);
});

Deno.test("冪等キーのない一意制約の違反はそのまま失敗にする", async () => {
  const failure = { code: "23505", message: "duplicate" };
  const { admin } = fakeAdmin([], null, {}, { data: null, error: failure });
  await assertRejects(() => provider(admin).create(newReservation).catch((e) => {
    throw new Error(e.message);
  }), Error, "duplicate");
});

Deno.test("新しく作った予約に existed は付かない", async () => {
  const { admin } = fakeAdmin([], null, {}, { data: row("confirmed"), error: null });
  assertEquals((await provider(admin).create(newReservation)).existed, undefined);
});
