// 予約の通知の文面。時刻は東京で出す
import type { Reservation } from "./reservation.ts";
import type { NewNotification } from "./notify.ts";

export type ReservationNoticeKind =
  | "reservation_pending"
  | "reservation_created"
  | "reservation_updated"
  | "reservation_cancelled"
  | "reservation_arrived";

const TITLES: Record<ReservationNoticeKind, string> = {
  reservation_pending: "仮予約が入りました",
  reservation_created: "予約が入りました",
  reservation_updated: "予約が変更されました",
  reservation_cancelled: "予約がキャンセルされました",
  reservation_arrived: "予約のお客様が到着しました",
};

const dateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// 11月2日（月）14:00
export function reservationTime(iso: string): string {
  const parts = Object.fromEntries(dateTime.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month}月${parts.day}日（${parts.weekday}）${parts.hour}:${parts.minute}`;
}

// Google カレンダーで直接作られた予定は件名をそのまま出す
function customerLabel(reservation: Reservation): string {
  const name = reservation.source === "external" ? reservation.customer_name : `${reservation.customer_name}様`;
  return reservation.service_name ? `${name}　${reservation.service_name}` : name;
}

export function reservationNotice(
  householdId: string,
  kind: ReservationNoticeKind,
  reservation: Reservation,
  dedupeKey: string,
  options: { title?: string; actorUserId?: string | null } = {},
): NewNotification {
  return {
    household_id: householdId,
    kind,
    title: options.title ?? TITLES[kind],
    body: `${reservationTime(reservation.starts_at)}\n${customerLabel(reservation)}`,
    data: { reservation_id: reservation.id },
    dedupe_key: dedupeKey,
    actor_user_id: options.actorUserId ?? null,
  };
}
