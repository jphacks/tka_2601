// 本体（PSoC 6）が来客を書き込み、モードを読むための Edge Function。
// PSoC は Supabase にログインせず、Authorization: Bearer <デバイス鍵> を付けて HTTPS で呼ぶ。
// 鍵の SHA-256 を device_keys と照らし、secret key（service_role）で DB の関数を呼ぶ。
//
//   GET /functions/v1/device/mode
//     → {"mode": "normal"}
//   PUT /functions/v1/device/visits/<来客 id>
//     本文: chimed_at, mode, status, answered_at, ended_at, end_reason, intent, company, outcome,
//           messages（任意。[{seq, speaker, text, spoken_at}]）
//     → {"id": "...", "status": "ended", "applied": true}
//
// どちらも、正しい鍵で呼ばれるたびに devices.last_seen_at を更新する。

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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    const key = bearerToken(req);
    if (!key) return Response.json({ error: "unauthorized" }, { status: 401 });

    const { data: devices, error: authError } = await ctx.supabaseAdmin.rpc("device_authenticate", {
      p_key_hash: await sha256Hex(key),
    });
    if (authError) throw authError;
    const device = (devices as { device_id: string; mode: string }[] | null)?.[0];
    if (!device) return Response.json({ error: "unauthorized" }, { status: 401 });

    const path = new URL(req.url).pathname;

    if (path.endsWith("/mode")) {
      if (req.method !== "GET") return methodNotAllowed();
      return Response.json({ mode: device.mode });
    }

    const visitPath = path.match(VISIT_PATH);
    if (visitPath) {
      if (req.method !== "PUT") return methodNotAllowed();
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "本文が JSON ではありません" }, { status: 400 });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return Response.json({ error: "本文はオブジェクトにしてください" }, { status: 400 });
      }
      const record = body as Record<string, unknown>;
      const messages = record.messages ?? [];
      if (!Array.isArray(messages)) {
        return Response.json({ error: "messages は配列にしてください" }, { status: 400 });
      }
      const visit = Object.fromEntries(
        VISIT_FIELDS.filter((f) => f in record).map((f) => [f, record[f]]),
      );

      const { data, error } = await ctx.supabaseAdmin.rpc("device_put_visit", {
        p_device_id: device.device_id,
        p_visit_id: visitPath[1].toLowerCase(),
        p_visit: visit,
        p_messages: messages,
      });
      if (error) {
        if (error.code === "42501") return Response.json({ error: error.message }, { status: 403 });
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
