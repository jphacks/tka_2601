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
//   PUT /functions/v1/device/pusher-status
//     本体保存値の版・内容と実行状態を報告する。希望設定は GET /settings の pusher_settings に含む。
//   GET /functions/v1/device/pusher-settings
//     XIAO向け。contract_version、paired、希望設定だけを返し、店舗・適用報告は含めない。
//   GET /functions/v1/device/mode-settings
//     XIAO向け。contract_version、paired、mode（normal / omakase / away / off）だけを返す。未ペアは mode が null。
//   PUT /functions/v1/device/mode-status
//     XIAO向け。本体が実際に適用しているモードの報告。本文: {"mode": "normal|omakase|away|off"}（他の項目は 400）
//     → {"applied_mode": "...", "applied_mode_at": "..."}。devices.applied_mode / applied_mode_at だけを書き、
//       アプリが保存した devices.mode は変えない。未ペアは 409
//   GET /functions/v1/device/chime-enrollment
//     XIAO向け。アプリが出したチャイム登録の依頼。{"contract_version": 1, "paired": true, "request_seq": 3, "action": "start"}。
//     依頼がなければ request_seq が 0、action が null。未ペアも同じ形で paired が false
//   PUT /functions/v1/device/chime-enrollment-status
//     XIAO向け。登録の進捗の報告。本文: {"handled_seq": 3, "phase": "listen", "reason": null, "registered": false}
//     （4項目だけ。phase は idle・noise・listen・analyze・saving・done・failed・cancelled。reason は failed のときだけ
//     too_noisy・too_short・clipped・no_recording・unstable・background_matches・busy）
//     → {request_seq, action, requested_at, handled_seq, phase, reason, registered, reported_at}。
//       handled_seq が request_seq を超える・今の handled_seq より小さい・未ペアは 409
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
