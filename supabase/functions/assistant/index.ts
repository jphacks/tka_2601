// アプリの自然言語の入力を案に変える Edge Function（docs/reservations.md 8章）。
//   POST /functions/v1/assistant/parse
//     本文: {"text": "木曜の14時に田中さん、ジェルネイルで"}（200 字まで）
//     → {"proposal": {"type": "add_reservation" | "update_reservation" | "set_business_hours" | "unknown", ...}}
//     解析器に届かなければ 503（code は assistant_unavailable）
//
// シークレット:
//   ASSISTANT_LLM_BASE_URL    解析器（Ollama）の URL。なければ 503
//   ASSISTANT_LLM_MODEL       モデル名（既定は gemma4:latest）
//   ASSISTANT_LLM_API_KEY     接続先が認証を求めるときの Bearer トークン（任意）
//   ASSISTANT_LLM_TIMEOUT_MS  待つ時間（既定は 20000）

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { intentParserFromEnv } from "../_shared/assistant/factory.ts";
import type { BusinessHour, ShopService } from "../_shared/assistant/intent_parser.ts";
import { providerFor } from "../_shared/calendar_store.ts";
import { authenticateMember } from "../_shared/member_auth.ts";
import { handleAssistantRequest } from "./handler.ts";

export default {
  fetch: withSupabase({ auth: "none" }, (req, ctx) => {
    const admin = ctx.supabaseAdmin as SupabaseClient;
    return handleAssistantRequest(req, {
      authenticate: (request) => authenticateMember(admin, request),
      parser: intentParserFromEnv(),
      providerFor: (householdId) => providerFor(admin, householdId),
      shopFor: (householdId) => readShop(admin, householdId),
    });
  }),
};

async function readShop(admin: SupabaseClient, householdId: string): Promise<{ services: ShopService[]; hours: BusinessHour[] }> {
  const [services, profile] = await Promise.all([
    admin.from("shop_services").select("name, duration_minutes").eq("household_id", householdId).order("sort_order"),
    admin.from("shop_profiles").select("business_hours").eq("household_id", householdId).maybeSingle(),
  ]);
  if (services.error) throw services.error;
  if (profile.error) throw profile.error;
  return {
    services: services.data as ShopService[],
    hours: (profile.data?.business_hours ?? []) as BusinessHour[],
  };
}
