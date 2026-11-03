// アカウントを削除する Edge Function（docs/reservations.md 3.3）。
// グループに入っていない人も消せるよう、JWT だけを確かめる。DELETE /functions/v1/account

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { createCalendarStore, googleConfigFromEnv } from "../_shared/calendar_store.ts";
import { authenticateUser } from "../_shared/member_auth.ts";
import { squareConfigFromEnv } from "../_shared/square.ts";
import { handleAccountRequest } from "./handler.ts";

export default {
  fetch: withSupabase({ auth: "none" }, (req, ctx) => {
    const admin = ctx.supabaseAdmin as SupabaseClient;
    return handleAccountRequest(req, {
      authenticate: (request) => authenticateUser(admin, request),
      async householdOf(userId) {
        const { data, error } = await admin.from("household_members").select("household_id").eq("user_id", userId).maybeSingle();
        if (error) throw error;
        return (data?.household_id as string | undefined) ?? null;
      },
      async memberCount(householdId) {
        const { count, error } = await admin.from("household_members")
          .select("user_id", { count: "exact", head: true })
          .eq("household_id", householdId);
        if (error) throw error;
        return count ?? 0;
      },
      async deleteHousehold(householdId) {
        const { error } = await admin.from("households").delete().eq("id", householdId);
        if (error) throw error;
      },
      async forgetPushTokens(userId) {
        const { error } = await admin.rpc("account_forget_push_tokens", { p_user_id: userId });
        if (error) throw error;
      },
      async deleteUser(userId) {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw error;
      },
      store: createCalendarStore(admin),
      config: googleConfigFromEnv(),
      squareConfig: squareConfigFromEnv(),
    });
  }),
};
