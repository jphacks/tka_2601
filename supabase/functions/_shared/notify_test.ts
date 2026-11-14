// deno test --allow-env supabase/functions/_shared/
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { notify, notifySafely } from "./notify.ts";

type RpcAdmin = Parameters<typeof notify>[0];

function fakeAdmin(replies: Record<string, { data: unknown; error: unknown }>) {
  const calls: string[] = [];
  const admin = {
    rpc(name: string) {
      calls.push(name);
      return Promise.resolve(replies[name] ?? { data: null, error: null });
    },
  } as unknown as RpcAdmin;
  return { admin, calls };
}

const notification = { household_id: "h1", kind: "chime", title: "t", body: "b", dedupe_key: "k" };

Deno.test("通知は1つの関数で記録と送信待ちを作り、送信待ちの分を送る", async () => {
  const { admin, calls } = fakeAdmin({
    notification_publish: { data: "n1", error: null },
    push_claim: { data: [], error: null },
  });
  const result = await notify(admin, notification);
  assertEquals(calls, ["notification_publish", "push_claim"]);
  assertEquals([result.notification_id, result.sent], ["n1", 0]);
});

Deno.test("記録に失敗したら notify は投げ、notifySafely は握りつぶす", async () => {
  const failure = { notification_publish: { data: null, error: new Error("db down") } };
  await assertRejects(() => notify(fakeAdmin(failure).admin, notification));
  await notifySafely(fakeAdmin(failure).admin, notification);
});
