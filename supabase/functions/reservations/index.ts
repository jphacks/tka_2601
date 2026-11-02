// アプリが予約と予約先を読み書きする Edge Function（docs/reservations.md 3.1）。
// /google/callback は Google が JWT なしで呼ぶため verify_jwt を切り、それ以外はここで JWT を確かめる。
//
// シークレット（Google カレンダーの接続を使うとき）:
//   GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET  Google Cloud の OAuth クライアント
//   RESERVATIONS_PUBLIC_URL  この関数の公開 URL。末尾に /google/callback を付けて Google に登録する
//   CALENDAR_TOKEN_KEY       更新トークンを暗号化する鍵（openssl rand -base64 32）
// シークレット（Square の接続を使うとき。RESERVATIONS_PUBLIC_URL と CALENDAR_TOKEN_KEY も要る）:
//   SQUARE_APPLICATION_ID、SQUARE_APPLICATION_SECRET  Square Developer Console のアプリ
//   SQUARE_ENVIRONMENT             production か sandbox（既定は production）
//   SQUARE_WEBHOOK_SIGNATURE_KEY   Webhook の署名鍵。<公開 URL>/square/webhook を登録する

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { createCalendarStore, googleConfigFromEnv, providerFor, squareClientFor } from "../_shared/calendar_store.ts";
import { authenticateMember } from "../_shared/member_auth.ts";
import { notifySafely } from "../_shared/notify.ts";
import { squareConfigFromEnv } from "../_shared/square.ts";
import { handleReservationsRequest } from "./handler.ts";

export default {
  fetch: withSupabase({ auth: "none" }, (req, ctx) => {
    const admin = ctx.supabaseAdmin as SupabaseClient;
    const store = createCalendarStore(admin);
    return handleReservationsRequest(req, {
      store,
      config: googleConfigFromEnv(),
      squareConfig: squareConfigFromEnv(),
      squareClient: (connection, config) => squareClientFor(admin, store, connection, config),
      authenticate: (request) => authenticateMember(admin, request),
      providerFor: (householdId) => providerFor(admin, householdId),
      notify: (notification) => notifySafely(admin, notification),
    });
  }),
};
