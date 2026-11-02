// 通知の記録を作り、端末ごとの送信待ちに入れて Expo に送る（docs/reservations.md 4章）
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  buildMessages,
  EXPO_BATCH_SIZE,
  ExpoError,
  type ExpoTicket,
  type Outcome,
  type SendOptions,
  sendBatch,
  ticketOutcome,
} from "./expo.ts";

export type NewNotification = {
  household_id: string;
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  dedupe_key: string;
  visit_id?: string | null;
  actor_user_id?: string | null;
};

export type Claimed = {
  id: number;
  notification_id: string;
  token: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
};

export type DeliveryResult = Outcome & { id: number; retry_after_seconds?: number };

// 一時的な失敗で送信待ちに残したとき、次に送るまでの秒数
const RETRY_AFTER_SECONDS = 60;

type RpcAdmin = Pick<SupabaseClient, "rpc">;

// 記録と送信待ちは1つのトランザクションで作る。同じ dedupe_key で送り直しても、受け付け済みの端末には送らない
export async function notify(admin: RpcAdmin, notification: NewNotification, send: SendOptions = defaultSend()) {
  const { data: id, error } = await admin.rpc("notification_publish", {
    p_household_id: notification.household_id,
    p_kind: notification.kind,
    p_title: notification.title,
    p_body: notification.body,
    p_data: notification.data ?? {},
    p_dedupe_key: notification.dedupe_key,
    p_visit_id: notification.visit_id ?? null,
    p_actor_user_id: notification.actor_user_id ?? null,
  });
  if (error) throw error;
  const claimed = await claim(admin, { p_notification_id: id });
  const { tickets, results } = await deliver(admin, claimed, send);
  return { notification_id: id as string, sent: claimed.length, tickets, results };
}

// 通知の失敗で予約の操作を失敗にしない
export async function notifySafely(admin: RpcAdmin, notification: NewNotification): Promise<void> {
  try {
    await notify(admin, notification);
  } catch (e) {
    console.error("notification failed", notification.kind, e);
  }
}

export async function claim(admin: RpcAdmin, args: Record<string, string> = {}): Promise<Claimed[]> {
  const { data, error } = await admin.rpc("push_claim", args);
  if (error) throw error;
  return data as Claimed[];
}

// 取り出した送信待ちを送り、結果を記録する
export async function deliver(admin: RpcAdmin, rows: Claimed[], send: SendOptions = defaultSend()) {
  const results: DeliveryResult[] = [];
  const tickets: ExpoTicket[] = [];

  for (let i = 0; i < rows.length; i += EXPO_BATCH_SIZE) {
    const batch = rows.slice(i, i + EXPO_BATCH_SIZE);
    try {
      const batchTickets = await sendBatch(buildMessages(batch), send);
      tickets.push(...batchTickets);
      batch.forEach((row, j) => results.push({ id: row.id, ...ticketOutcome(batchTickets[j]) }));
    } catch (e) {
      if (!(e instanceof ExpoError)) throw e;
      console.error("Expo push failed", e.message);
      for (const row of batch) {
        results.push(
          e.retryable
            ? { id: row.id, status: "retry", error: e.message, retry_after_seconds: RETRY_AFTER_SECONDS }
            : { id: row.id, status: "failed", error: e.message },
        );
      }
    }
  }

  // DeviceNotRegistered などは記録だけ残す。トークンの削除はアプリが行う
  for (const r of results) if (r.status !== "accepted") console.error("push delivery", r.status, r.error);
  if (results.length > 0) {
    const { error } = await admin.rpc("push_finish", { p_results: results });
    if (error) throw error;
  }
  return { tickets, results };
}

function defaultSend(): SendOptions {
  return { accessToken: Deno.env.get("EXPO_ACCESS_TOKEN") };
}
