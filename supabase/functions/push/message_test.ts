// deno test supabase/functions/push/message_test.ts
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { chimeNotice, endedNotice, noticeKind, type Visit, type WebhookPayload } from "./message.ts";

const visit: Visit = {
  id: "00000000-0000-4000-8000-000000000001",
  household_id: "00000000-0000-4000-8000-000000000002",
  mode: "omakase",
  chimed_at: "2026-10-17T01:32:00Z",
  status: "ringing",
  intent: null,
  company: null,
  outcome: null,
};

function payload(type: WebhookPayload["type"], record: Visit, old: Visit | null): WebhookPayload {
  return { type, table: "visits", schema: "public", record, old_record: old };
}

Deno.test("来客の作成で来客時の通知、終話への更新で対応後の通知を送る", () => {
  assertEquals(noticeKind(payload("INSERT", visit, null)), "chime");
  const ended = { ...visit, status: "ended" as const };
  assertEquals(noticeKind(payload("UPDATE", ended, { ...visit, status: "in_call" })), "ended");
  // 終話のまま送り直された更新と、応答しなかった来客には送らない
  assertEquals(noticeKind(payload("UPDATE", ended, ended)), null);
  assertEquals(noticeKind(payload("UPDATE", { ...visit, status: "missed" }, visit)), null);
  assertEquals(noticeKind({ ...payload("INSERT", visit, null), table: "devices" }), null);
});

Deno.test("終話済みの来客が初めて届いたときは対応後の通知だけを送る", () => {
  assertEquals(noticeKind(payload("INSERT", { ...visit, status: "ended" }, null)), "ended");
  assertEquals(noticeKind(payload("INSERT", { ...visit, status: "missed" }, null)), "chime");
});

Deno.test("来客時の通知は時刻（東京）を載せる", () => {
  assertEquals(chimeNotice(visit), {
    kind: "chime",
    title: "来客があります",
    body: "10:32 にチャイムが鳴りました",
  });
});

Deno.test("対応後の通知は意図、会社名、対応、発話の抜粋を載せる", () => {
  const ended: Visit = {
    ...visit,
    status: "ended",
    intent: "delivery",
    company: "ヤマト運輸",
    outcome: "leave_at_door",
  };
  assertEquals(endedNotice(ended, "ヤマト運輸です。お荷物のお届けに参りました。"), {
    kind: "ended",
    title: "宅配（ヤマト運輸）",
    body: "置き配をお願いしました\n「ヤマト運輸です。お荷物のお届けに参りました。」",
  });
});

Deno.test("外出モードで不在票なら再配達を促し、抜粋は 40 字で切る", () => {
  const ended: Visit = { ...visit, mode: "away", status: "ended", intent: "delivery", outcome: "delivery_slip" };
  const text = "あ".repeat(41);
  assertEquals(endedNotice(ended, text).body, `不在票をお願いしました。再配達の手配をしてください\n「${"あ".repeat(40)}…」`);
});

Deno.test("知人の来客は題に「知人」を載せる", () => {
  const ended: Visit = { ...visit, status: "ended", intent: "acquaintance", outcome: "escalated" };
  assertEquals(endedNotice(ended, null).title, "知人");
});

Deno.test("意図と対応がなく発話もなければ、その旨を載せる", () => {
  assertEquals(endedNotice({ ...visit, status: "ended" }, null), {
    kind: "ended",
    title: "来客",
    body: "対応は記録されていません",
  });
});
