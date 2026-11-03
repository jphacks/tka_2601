// 来客の通知を Expo の通知サービスで端末に送る（docs/history.md 2章・5章、docs/reservations.md 4章）。
//   Webhook（private.notify_visit_push）: 来客の作成と終話への更新のとき。通知の記録を作り、端末ごとに送信待ちに入れてから送る
//   再送（private.retry_push_deliveries、pg_cron が1分ごと）: 本文 {"type": "RETRY"}。送る時期が来た送信待ちを送る
// 送信待ちは push_deliveries にあり、受け付けられた端末には二度と送らない。
//
// シークレット:
//   PUSH_WEBHOOK_SECRET  Webhook の合言葉。Vault の push_webhook_secret と同じ値
//   EXPO_ACCESS_TOKEN    Expo のアクセストークン（Enhanced Security を有効にした場合に要る）

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { claim, deliver, notify } from "../_shared/notify.ts";
import { hasWebhookSecret } from "../_shared/secret.ts";
import { chimeNotice, endedNotice, type Notice, noticeKind, type Visit, type WebhookPayload } from "./message.ts";

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
      const claimed = await claim(admin);
      const { results } = await deliver(admin, claimed);
      return Response.json({ retried: claimed.length, results });
    }

    const webhook = payload as WebhookPayload;
    const kind = noticeKind(webhook);
    if (!kind) return Response.json({ skipped: true });
    const visit = webhook.record;

    const notice = await buildNotice(admin, visit.id, kind);
    if (!notice) return Response.json({ sent: 0 });
    const { sent, tickets } = await notify(admin, {
      household_id: visit.household_id,
      kind,
      title: notice.title,
      body: notice.body,
      data: { visit_id: visit.id },
      dedupe_key: `visit:${visit.id}:${kind}`,
      visit_id: visit.id,
    });
    // 返事は Webhook の記録（net._http_response）に残り、試験で文面を確かめるのに使う
    return Response.json({ sent, notice, tickets });
  }),
};

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
