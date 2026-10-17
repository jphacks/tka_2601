// 来客の通知を Expo の通知サービスで住人の端末に送る（docs/history.md 2章・5章）。
//   Webhook（private.notify_visit_push）: 来客の作成と終話への更新のとき。端末ごとに送信待ちに入れてから送る
//   再送（private.retry_push_deliveries、pg_cron が1分ごと）: 本文 {"type": "RETRY"}。送る時期が来た送信待ちを送る
// 送信待ちは push_deliveries にあり、受け付けられた端末には二度と送らない。
//
// シークレット:
//   PUSH_WEBHOOK_SECRET  Webhook の合言葉。Vault の push_webhook_secret と同じ値
//   EXPO_ACCESS_TOKEN    Expo のアクセストークン（Enhanced Security を有効にした場合に要る）

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { chimeNotice, endedNotice, type Notice, noticeKind, type Visit, type WebhookPayload } from "./message.ts";
import { buildMessages, EXPO_BATCH_SIZE, ExpoError, type ExpoTicket, type Outcome, sendBatch, ticketOutcome } from "./expo.ts";

type Claimed = { id: number; visit_id: string; kind: Notice["kind"]; token: string };
type Result = Outcome & { id: number; retry_after_seconds?: number };

// 一時的な失敗で送信待ちに残したとき、次に送るまでの秒数
const RETRY_AFTER_SECONDS = 60;

// 呼び出し元は Webhook と pg_cron だけなので、verify_jwt を切り、合言葉で確かめる
export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!hasWebhookSecret(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const admin = ctx.supabaseAdmin as SupabaseClient;
    const payload = await req.json() as WebhookPayload | { type: "RETRY" };

    if (payload.type === "RETRY") {
      const claimed = await claim(admin, {});
      const groups = new Map<string, Claimed[]>();
      for (const row of claimed) {
        const key = `${row.visit_id}:${row.kind}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const results: Result[] = [];
      for (const rows of groups.values()) {
        results.push(...(await deliver(admin, rows[0].visit_id, rows[0].kind, rows)).results);
      }
      return Response.json({ retried: claimed.length, results });
    }

    const kind = noticeKind(payload as WebhookPayload);
    if (!kind) return Response.json({ skipped: true });
    const visitId = (payload as WebhookPayload).record.id;

    const { error: enqueueError } = await admin.rpc("push_enqueue", { p_visit_id: visitId, p_kind: kind });
    if (enqueueError) throw enqueueError;
    const claimed = await claim(admin, { p_visit_id: visitId, p_kind: kind });
    if (claimed.length === 0) return Response.json({ sent: 0 });

    const { notice, tickets } = await deliver(admin, visitId, kind, claimed);
    // 返事は Webhook の記録（net._http_response）に残り、試験で文面を確かめるのに使う
    return Response.json({ sent: claimed.length, notice, tickets });
  }),
};

async function claim(admin: SupabaseClient, args: Record<string, string>): Promise<Claimed[]> {
  const { data, error } = await admin.rpc("push_claim", args);
  if (error) throw error;
  return data as Claimed[];
}

// 取り出した送信待ちを送り、結果を記録する
async function deliver(admin: SupabaseClient, visitId: string, kind: Notice["kind"], rows: Claimed[]) {
  const results: Result[] = [];
  const tickets: ExpoTicket[] = [];
  const notice = await buildNotice(admin, visitId, kind);

  if (!notice) {
    for (const row of rows) results.push({ id: row.id, status: "failed", error: "来客が消された" });
  } else {
    for (let i = 0; i < rows.length; i += EXPO_BATCH_SIZE) {
      const batch = rows.slice(i, i + EXPO_BATCH_SIZE);
      try {
        const batchTickets = await sendBatch(
          buildMessages(batch.map((r) => r.token), notice, visitId),
          { accessToken: Deno.env.get("EXPO_ACCESS_TOKEN") },
        );
        tickets.push(...batchTickets);
        batch.forEach((row, j) => results.push({ id: row.id, ...ticketOutcome(batchTickets[j]) }));
      } catch (e) {
        if (!(e instanceof ExpoError)) throw e;
        console.error("Expo push failed", e.message);
        for (const row of batch) {
          results.push(
            e.retryable
              ? { id: row.id, status: "retry", error: e.message, retry_after_seconds: RETRY_AFTER_SECONDS }
              : { id: row.id, status: "failed", error: e.message },
          );
        }
      }
    }
  }

  // DeviceNotRegistered などは記録だけ残す。トークンの削除は住人のアプリが行う
  for (const r of results) if (r.status !== "accepted") console.error("push delivery", r.status, r.error);
  const { error } = await admin.rpc("push_finish", { p_results: results });
  if (error) throw error;
  return { notice, tickets, results };
}

// 今の来客の行から文面を作る。来客が消されていれば null
async function buildNotice(admin: SupabaseClient, visitId: string, kind: Notice["kind"]): Promise<Notice | null> {
  const { data: visit, error } = await admin.from("visits").select("*").eq("id", visitId).maybeSingle();
  if (error) throw error;
  if (!visit) return null;
  if (kind === "chime") return chimeNotice(visit as Visit);

  const { data: first, error: messageError } = await admin
    .from("visit_messages")
    .select("text")
    .eq("visit_id", visitId)
    .eq("speaker", "visitor")
    .order("seq")
    .limit(1)
    .maybeSingle();
  if (messageError) throw messageError;
  return endedNotice(visit as Visit, (first as { text: string } | null)?.text ?? null);
}

function hasWebhookSecret(req: Request): boolean {
  const expected = Deno.env.get("PUSH_WEBHOOK_SECRET");
  const actual = req.headers.get("x-webhook-secret");
  if (!expected || !actual) return false;
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
