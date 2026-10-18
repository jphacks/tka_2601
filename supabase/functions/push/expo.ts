// Expo の通知サービスへの送信。一時的な失敗は間を空けて数回試す
// https://docs.expo.dev/push-notifications/sending-notifications/

import type { Notice } from "./message.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
// Expo が1回で受け付ける通知の数の上限
export const EXPO_BATCH_SIZE = 100;
// 関数の中で試し直す前の待ち時間。これで届かなければ送信待ちに残し、pg_cron の再送に任せる
const RETRY_DELAYS_MS = [1000, 3000];

export type ExpoTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

export type Outcome = { status: "accepted" | "failed" | "retry"; error?: string };

// retryable: ネットワーク、429、5xx。時間をおけば届く見込みがある
export class ExpoError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export type SendOptions = {
  accessToken?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
};

// 来客時も対応後も、Android の省電力中に遅らせないよう優先度を high にする
export function buildMessages(tokens: string[], notice: Notice, visitId: string) {
  return tokens.map((to) => ({
    to,
    title: notice.title,
    body: notice.body,
    sound: "default",
    priority: "high",
    // アプリが通知から来客の詳細を開くため
    data: { visit_id: visitId, kind: notice.kind },
  }));
}

// 1回分（100 件まで）を送り、端末ごとの ticket を同じ順で返す
export async function sendBatch(messages: unknown[], options: SendOptions = {}): Promise<ExpoTicket[]> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const headers: Record<string, string> = { "Accept": "application/json", "Content-Type": "application/json" };
  if (options.accessToken) headers["Authorization"] = `Bearer ${options.accessToken}`;

  for (let attempt = 0;; attempt++) {
    const result = await sendAttempt(messages, doFetch, headers);
    if (result.ok) return result.tickets;
    if (!result.error.retryable || attempt >= delays.length) throw result.error;
    await sleep(delays[attempt]);
  }
}

type SendAttempt =
  | { ok: true; tickets: ExpoTicket[] }
  | { ok: false; error: ExpoError };

async function sendAttempt(
  messages: unknown[],
  doFetch: typeof fetch,
  headers: Record<string, string>,
): Promise<SendAttempt> {
  try {
    const res = await doFetch(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(messages) });
    const json = await res.json().catch(() => null);
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, error: new ExpoError(`Expo HTTP ${res.status}`, true) };
    }
    if (!res.ok || !json || json.errors || !Array.isArray(json.data)) {
      return { ok: false, error: new ExpoError(`Expo HTTP ${res.status} ${JSON.stringify(json?.errors ?? json)}`, false) };
    }
    return { ok: true, tickets: json.data as ExpoTicket[] };
  } catch (error) {
    if (error instanceof ExpoError) throw error;
    return {
      ok: false,
      error: new ExpoError(`Expo network error: ${error instanceof Error ? error.message : String(error)}`, true),
    };
  }
}

// ticket を送信待ちの結果に直す。MessageRateExceeded は時間をおけば届くので送り直す
export function ticketOutcome(ticket: ExpoTicket | undefined): Outcome {
  if (!ticket) return { status: "retry", error: "Expo から ticket が返らなかった" };
  if (ticket.status === "ok") return { status: "accepted" };
  const code = ticket.details?.error;
  const error = [code, ticket.message].filter(Boolean).join(": ");
  return code === "MessageRateExceeded" ? { status: "retry", error } : { status: "failed", error };
}
