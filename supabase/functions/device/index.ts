// 本体（PSoC 6）が来客を書き込み、設定を読むための Edge Function。
// PSoC は Supabase にログインせず、Authorization: Bearer <デバイス鍵> を付けて HTTPS で呼ぶ。
// 鍵の SHA-256 を device_keys と照らし、secret key（service_role）で DB の関数を呼ぶ。
//
//   GET /functions/v1/device/settings（/mode も同じ）
//     → {"contract_version": 1, "paired": true, "mode": "normal", "away_leave_at_door": false, "auto_away": false,
//        "extra_instructions": "", "shop": {店舗の設定。読めなければ null}}
//   PUT /functions/v1/device/state
//     本文: {"auto_away_active": true}（レーダーで自動的に外出にしているか）
//     → {"auto_away_active": true}
//   PUT /functions/v1/device/heartbeat
//     本体の死活通信。15 分途絶えると店に通知する → {"last_heartbeat_at": "..."}
//   GET /functions/v1/device/reservations?from=&to=（31 日まで）
//     → {"provider": "monban", "reservations": [...]}。電話番号とメモは返さない
//   POST /functions/v1/device/reservations
//     本文: customer_name, starts_at, ends_at, customer_phone, service_name, note, visit_id（後ろの4つは任意）
//     → 201 {"reservation": {...}}。必ず仮予約になる。時間が重なれば 409
//   POST /functions/v1/device/reservations/<予約 id>/arrive
//     → {"reservation": {...}}。到着を記録して店に通知する
//   PUT /functions/v1/device/visits/<来客 id>
//     本文: chimed_at, mode, status, answered_at, ended_at, end_reason, intent, company, outcome,
//           messages（任意。[{seq, speaker, text, spoken_at}]）
//     → {"id": "...", "status": "ended", "applied": true}
//
// 返す形は contract.ts に集めてある。
// どれも、正しい鍵で呼ばれるたびに devices.last_seen_at を更新する。
// グループに結び付く前（paired が false）の本体は来客を書けず、409 を返す。

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

import { providerFor } from "../_shared/calendar_store.ts";
import { notifySafely } from "../_shared/notify.ts";
import { handleDeviceRequest } from "./handler.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  fetch: withSupabase({ auth: "none" }, (req, ctx) => {
    const admin = ctx.supabaseAdmin as SupabaseClient;
    return handleDeviceRequest(req, admin, {
      providerFor: (householdId) => providerFor(admin, householdId),
      notify: (notification) => notifySafely(admin, notification),
      async visitBelongs(householdId, visitId) {
        if (!UUID.test(visitId)) return false;
        const { data, error } = await admin.from("visits").select("id")
          .eq("id", visitId)
          .eq("household_id", householdId)
          .maybeSingle();
        if (error) throw error;
        return data !== null;
      },
    });
  }),
};
