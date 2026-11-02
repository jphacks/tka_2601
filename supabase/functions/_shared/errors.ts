// 予約の操作の失敗を HTTP の返事に直す。知らない失敗はそのまま投げる
import { GoogleApiError, GoogleAuthError } from "./google_calendar.ts";
import { ProviderError } from "./reservation.ts";
import { SquareApiError, SquareAuthError } from "./square.ts";

export function reservationErrorResponse(e: unknown): Response {
  if (e instanceof ProviderError) {
    return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status });
  }
  if (e instanceof GoogleAuthError) {
    return Response.json({ error: "Google カレンダーに接続し直してください", code: "google_reauth_required" }, { status: 502 });
  }
  if (e instanceof GoogleApiError) {
    console.error(e.message);
    return Response.json({ error: "Google カレンダーに接続できません", code: "google_unavailable" }, { status: 502 });
  }
  if (e instanceof SquareAuthError) {
    return Response.json({ error: "Square にログインし直してください", code: "square_reauth_required" }, { status: 502 });
  }
  if (e instanceof SquareApiError) {
    console.error(e.message);
    return Response.json({ error: "Square に接続できません", code: "square_unavailable" }, { status: 502 });
  }
  throw e;
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ProviderError(400, "本文が JSON ではありません");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ProviderError(400, "本文はオブジェクトにしてください");
  }
  return body as Record<string, unknown>;
}
