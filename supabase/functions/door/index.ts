// アプリがボイスバックエンドの受付設定と Google カレンダー連携を使う Edge Function。/functions/v1/door/...
//
// シークレット:
//   DOOR_API_BASE_URL            ボイスバックエンドの URL（例 https://door-ui.shionkk.f5.si）
//   DOOR_API_KEY                 ボイスバックエンドの Bearer 鍵。アプリには渡さない
//   DOOR_ALLOWED_HOUSEHOLD_IDS   使えるグループの id をカンマで区切る。バックエンドは店ごとに分かれていないため

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { authenticateMember } from "../_shared/member_auth.ts";
import { doorConfigFromEnv, handleDoorRequest } from "./handler.ts";

export default {
  fetch: withSupabase({ auth: "none" }, (req, ctx) => {
    const admin = ctx.supabaseAdmin as SupabaseClient;
    return handleDoorRequest(req, {
      authenticate: (request) => authenticateMember(admin, request),
      config: doorConfigFromEnv(),
    });
  }),
};
