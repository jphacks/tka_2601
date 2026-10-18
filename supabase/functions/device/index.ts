// 本体（PSoC 6）が来客を書き込み、設定を読むための Edge Function。
// PSoC は Supabase にログインせず、Authorization: Bearer <デバイス鍵> を付けて HTTPS で呼ぶ。
// 鍵の SHA-256 を device_keys と照らし、secret key（service_role）で DB の関数を呼ぶ。
//
//   GET /functions/v1/device/settings（/mode も同じ）
//     → {"paired": true, "mode": "normal", "away_leave_at_door": false, "auto_away": false,
//        "extra_instructions": ""}
//   PUT /functions/v1/device/state
//     本文: {"auto_away_active": true}（レーダーで自動的に外出にしているか）
//     → {"auto_away_active": true}
//   PUT /functions/v1/device/visits/<来客 id>
//     本文: chimed_at, mode, status, answered_at, ended_at, end_reason, intent, company, outcome,
//           messages（任意。[{seq, speaker, text, spoken_at}]）
//     → {"id": "...", "status": "ended", "applied": true}
//
// どれも、正しい鍵で呼ばれるたびに devices.last_seen_at を更新する。
// グループに結び付く前（paired が false）の本体は来客を書けず、409 を返す。

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { handleDeviceRequest } from "./handler.ts";

export default {
  fetch: withSupabase({ auth: "none" }, (req, ctx) => handleDeviceRequest(req, ctx.supabaseAdmin)),
};
