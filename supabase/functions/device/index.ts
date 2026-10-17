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

const VISIT_PATH = /\/visits\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const VISIT_FIELDS = [
  "chimed_at",
  "mode",
  "status",
  "answered_at",
  "ended_at",
  "end_reason",
  "intent",
  "company",
  "outcome",
] as const;

// 入力の誤り（値の範囲、型、必須の欠け、外部キー）として 400 を返す SQLSTATE
const BAD_REQUEST_CODES = new Set(["22023", "22P02", "22007", "22008", "23502", "23503", "23514"]);

type Device = {
  device_id: string;
  household_id: string | null;
  mode: string;
  away_leave_at_door: boolean;
  auto_away: boolean;
  extra_instructions: string;
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    const key = bearerToken(req);
    if (!key) return Response.json({ error: "unauthorized" }, { status: 401 });

    const { data: devices, error: authError } = await ctx.supabaseAdmin.rpc("device_authenticate", {
      p_key_hash: await sha256Hex(key),
    });
    if (authError) throw authError;
    const device = (devices as Device[] | null)?.[0];
    if (!device) return Response.json({ error: "unauthorized" }, { status: 401 });

    const path = new URL(req.url).pathname;

    if (path.endsWith("/settings") || path.endsWith("/mode")) {
      if (req.method !== "GET") return methodNotAllowed();
      return Response.json({
        paired: device.household_id !== null,
        mode: device.mode,
        away_leave_at_door: device.away_leave_at_door,
        auto_away: device.auto_away,
        extra_instructions: device.extra_instructions,
      });
    }

    if (path.endsWith("/state")) {
      if (req.method !== "PUT") return methodNotAllowed();
      const body = await readObject(req);
      if (body instanceof Response) return body;
      if (typeof body.auto_away_active !== "boolean") {
        return Response.json({ error: "auto_away_active は true か false にしてください" }, { status: 400 });
      }
      const { data, error } = await ctx.supabaseAdmin.rpc("device_set_state", {
        p_device_id: device.device_id,
        p_auto_away_active: body.auto_away_active,
      });
      if (error) throw error;
      return Response.json(data);
    }

    const visitPath = path.match(VISIT_PATH);
    if (visitPath) {
      if (req.method !== "PUT") return methodNotAllowed();
      const body = await readObject(req);
      if (body instanceof Response) return body;
      const messages = body.messages ?? [];
      if (!Array.isArray(messages)) {
        return Response.json({ error: "messages は配列にしてください" }, { status: 400 });
      }
      const visit = Object.fromEntries(
        VISIT_FIELDS.filter((f) => f in body).map((f) => [f, body[f]]),
      );

      const { data, error } = await ctx.supabaseAdmin.rpc("device_put_visit", {
        p_device_id: device.device_id,
        p_visit_id: visitPath[1].toLowerCase(),
        p_visit: visit,
        p_messages: messages,
      });
      if (error) {
        if (error.code === "42501") return Response.json({ error: error.message }, { status: 403 });
        if (error.code === "PT409") return Response.json({ error: error.message }, { status: 409 });
        if (BAD_REQUEST_CODES.has(error.code)) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
      return Response.json(data);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }),
};

// 本文を JSON のオブジェクトとして読む。だめなら 400 の Response を返す
async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "本文が JSON ではありません" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "本文はオブジェクトにしてください" }, { status: 400 });
  }
  return body as Record<string, unknown>;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
