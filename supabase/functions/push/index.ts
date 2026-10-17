// 来客の通知を Expo の通知サービスで住人の端末に送る（docs/history.md 2章・5章）。
// Database Webhook（マイグレーションの private.notify_visit_push）から呼ばれる。
//
// シークレット:
//   PUSH_WEBHOOK_SECRET  Webhook の合言葉。Vault の push_webhook_secret と同じ値
//   EXPO_ACCESS_TOKEN    Expo のアクセストークン（Enhanced Security を有効にした場合に要る）

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { chimeNotice, endedNotice, type Notice, noticeKind, type WebhookPayload } from "./message.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
// Expo が1回で受け付ける通知の数の上限
const EXPO_BATCH_SIZE = 100;

type ExpoTicket = { status: "ok" | "error"; id?: string; message?: string; details?: unknown };

// 呼び出し元は Webhook だけなので、verify_jwt を切り、合言葉で確かめる
export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!hasWebhookSecret(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const payload: WebhookPayload = await req.json();
    const kind = noticeKind(payload);
    if (!kind) return Response.json({ skipped: true });
    const visit = payload.record;

    // 送り先は、その家の住人全員の端末
    const { data: members, error: membersError } = await ctx.supabaseAdmin
      .from("household_members")
      .select("user_id")
      .eq("household_id", visit.household_id);
    if (membersError) throw membersError;
    const userIds = (members as { user_id: string }[]).map((m) => m.user_id);
    if (userIds.length === 0) return Response.json({ sent: 0 });

    const { data: tokenRows, error: tokensError } = await ctx.supabaseAdmin
      .from("push_tokens")
      .select("token")
      .in("user_id", userIds);
    if (tokensError) throw tokensError;
    const tokens = [...new Set((tokenRows as { token: string }[]).map((t) => t.token))];
    if (tokens.length === 0) return Response.json({ sent: 0 });

    let notice: Notice;
    if (kind === "chime") {
      notice = chimeNotice(visit);
    } else {
      const { data: first, error: messageError } = await ctx.supabaseAdmin
        .from("visit_messages")
        .select("text")
        .eq("visit_id", visit.id)
        .eq("speaker", "visitor")
        .order("seq")
        .limit(1)
        .maybeSingle();
      if (messageError) throw messageError;
      notice = endedNotice(visit, (first as { text: string } | null)?.text ?? null);
    }

    const tickets = await sendToExpo(tokens, notice, visit.id);
    // DeviceNotRegistered などは記録だけ残す。トークンの削除は住人のアプリが行う
    for (const ticket of tickets) {
      if (ticket.status === "error") console.error("Expo ticket error", ticket.message, ticket.details);
    }
    // 返事は Webhook の記録（net._http_response）に残り、試験で文面を確かめるのに使う
    return Response.json({ sent: tokens.length, notice, tickets });
  }),
};

async function sendToExpo(tokens: string[], notice: Notice, visitId: string): Promise<ExpoTicket[]> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  const accessToken = Deno.env.get("EXPO_ACCESS_TOKEN");
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < tokens.length; i += EXPO_BATCH_SIZE) {
    const messages = tokens.slice(i, i + EXPO_BATCH_SIZE).map((to) => ({
      to,
      title: notice.title,
      body: notice.body,
      sound: "default",
      // アプリが通知から来客の詳細を開くため
      data: { visit_id: visitId, kind: notice.kind },
    }));
    const res = await fetch(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(messages) });
    const json = await res.json();
    if (!res.ok || json.errors) {
      throw new Error(`Expo push failed: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
    }
    tickets.push(...json.data);
  }
  return tickets;
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
