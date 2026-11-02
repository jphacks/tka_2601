// Google カレンダーの差分を読む Edge Function（docs/reservations.md 4.1）。
// pg_cron（private.poll_calendar_connections）が1分ごとに本文 {"type": "POLL"} で呼ぶ。
// 呼び出し元は pg_cron だけなので、verify_jwt を切り、PUSH_WEBHOOK_SECRET で確かめる

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { clientForConnection, createCalendarStore, googleConfigFromEnv } from "../_shared/calendar_store.ts";
import { notify } from "../_shared/notify.ts";
import { hasWebhookSecret } from "../_shared/secret.ts";
import { syncIfFree } from "./sync.ts";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!hasWebhookSecret(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

    const config = googleConfigFromEnv();
    if (!config) return Response.json({ skipped: "Google カレンダーの接続が設定されていません" });

    const admin = ctx.supabaseAdmin as SupabaseClient;
    const store = createCalendarStore(admin);
    const connections = await store.activeConnections();
    const results = [];
    for (const connection of connections) {
      results.push(await syncIfFree(connection, {
        store,
        client: (c) => clientForConnection(c, config),
        notify: (notification) => notify(admin, notification),
      }));
    }
    return Response.json({ results });
  }),
};
