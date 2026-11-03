// Google カレンダーの差分を読み、変わった予約を通知する（docs/reservations.md 4.1）
import type { CalendarConnection, CalendarStore } from "../_shared/calendar_store.ts";
import { eventToReservation, GoogleApiError, type GoogleClient, googleDedupeKey, type GoogleEvent, GoogleSyncExpired } from "../_shared/google_calendar.ts";
import type { NewNotification } from "../_shared/notify.ts";
import { type ReservationNoticeKind, reservationNotice, reservationTime } from "../_shared/reservation_notice.ts";

// 1回の差分でこの件数を超えたら1件にまとめる（繰り返しの予定の変更など）
export const BULK_THRESHOLD = 10;
// 作成と更新の時刻の差がこれ以内なら、新しく作られた予定として扱う
const NEW_EVENT_MS = 60_000;
// 一時的な失敗が続いたら、この時間で通知する
const TRANSIENT_ALERT_MS = 10 * 60_000;

export function classifyChange(event: GoogleEvent, now: Date): ReservationNoticeKind | null {
  // 終日の予定は予約ではない
  if (event.start?.date) return null;
  // 終わった予定の変更は知らせない
  const end = event.end?.dateTime;
  if (end && Date.parse(end) < now.getTime()) return null;
  const timed = !!event.start?.dateTime && !!event.end?.dateTime;
  // 削除された予定は id しか返らないことがあり、終日かどうか分からないので個別のキャンセルにしない
  if (event.status === "cancelled") return timed ? "reservation_cancelled" : "reservation_updated";
  if (!timed) return null;
  const isNew = event.created && event.updated &&
    Date.parse(event.updated) - Date.parse(event.created) < NEW_EVENT_MS;
  if (!isNew) return "reservation_updated";
  return event.status === "tentative" ? "reservation_pending" : "reservation_created";
}

export function changeNotice(householdId: string, event: GoogleEvent, kind: ReservationNoticeKind): NewNotification {
  const reservation = eventToReservation(event);
  if (reservation) return reservationNotice(householdId, kind, reservation, googleDedupeKey(event));
  // 時刻の分からない削除。予定はもうないので、予約の画面へは案内しない
  return {
    household_id: householdId,
    kind,
    title: "予約先の予定が削除されました",
    body: "Google カレンダーを確かめてください",
    data: {},
    dedupe_key: googleDedupeKey(event),
  };
}

// dedupe_key は読み始めの目印から作る。読み直しても同じ差分なら同じキーになり、二重に通知しない
export function bulkNotice(householdId: string, count: number, firstStart: string | undefined, fromToken: string): NewNotification {
  return {
    household_id: householdId,
    kind: "reservation_updated",
    title: "予約がまとめて変更されました",
    body: firstStart ? `${count} 件（${reservationTime(firstStart)} から）` : `${count} 件`,
    data: {},
    dedupe_key: `google:bulk:${fromToken}`,
  };
}

export type SyncDeps = {
  store: CalendarStore;
  client: (connection: CalendarConnection) => Promise<GoogleClient>;
  // 失敗は投げてよい。差分の目印を進めないので次の回に読み直す。
  // 記録と送信待ちは同時に作られ、dedupe_key で二重にならず、足りない送信待ちだけが入る
  notify: (notification: NewNotification) => Promise<unknown>;
  now?: () => Date;
};

export type SyncResult = { household_id: string; outcome: "baseline" | "synced" | "failed" | "skipped"; notified: number; error?: string };

// 権利を取ってから、最新の目印で読む。読み取りが重なると古い目印で上書きしてしまう。権利が取れなければ次の回に任せる
export async function syncIfFree(connection: CalendarConnection, deps: SyncDeps): Promise<SyncResult> {
  const householdId = connection.household_id;
  let leased = false;
  try {
    leased = await deps.store.acquireSyncLease(householdId);
    if (!leased) return { household_id: householdId, outcome: "skipped", notified: 0 };
    const latest = await deps.store.getConnection(householdId);
    if (!latest?.calendar_id) return { household_id: householdId, outcome: "skipped", notified: 0 };
    return await syncConnection(latest, deps);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("calendar sync lease failed", householdId, message);
    return { household_id: householdId, outcome: "failed", notified: 0, error: message };
  } finally {
    // 解放に失敗しても、権利は期限で切れる
    if (leased) await deps.store.releaseSyncLease(householdId).catch((e) => console.error("calendar sync lease not released", householdId, e));
  }
}

// 接続ごとの失敗を他の店に波及させない
export async function syncConnection(connection: CalendarConnection, deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now?.() ?? new Date();
  const householdId = connection.household_id;
  try {
    const client = await deps.client(connection);
    const calendarId = connection.calendar_id!;
    let token = connection.sync_token;
    let outcome: SyncResult["outcome"] = "synced";
    let notified = 0;

    if (token) {
      try {
        const { items, nextSyncToken } = await client.changes(calendarId, token);
        notified = await notifyChanges(householdId, items, token, now, deps);
        token = nextSyncToken;
      } catch (e) {
        if (!(e instanceof GoogleSyncExpired)) throw e;
        token = null;
      }
    }
    if (!token) {
      token = await client.baseline(calendarId, now.toISOString());
      outcome = "baseline";
    }

    await deps.store.updateConnection(householdId, {
      sync_token: token,
      status: "active",
      last_error: null,
      last_synced_at: now.toISOString(),
    });
    return { household_id: householdId, outcome, notified };
  } catch (e) {
    return await recordFailure(connection, e, now, deps);
  }
}

async function notifyChanges(householdId: string, items: GoogleEvent[], fromToken: string, now: Date, deps: SyncDeps): Promise<number> {
  const writeIdOf = (event: GoogleEvent) => event.extendedProperties?.private?.monban_write;
  // 印のない削除は id しか返っていないことがあるので、予定の id で探す
  const withoutMark = (event: GoogleEvent) => event.status === "cancelled" && !writeIdOf(event);
  const own = await deps.store.ownWrites(
    householdId,
    items.map(writeIdOf).filter((id): id is string => !!id),
    items.filter(withoutMark).map((event) => event.id),
  );
  const ownWriteOf = (event: GoogleEvent) =>
    own.find((row) => writeIdOf(event) ? row.write_id === writeIdOf(event) : withoutMark(event) && row.event_id === event.id);
  const matched = items.map(ownWriteOf).filter((row) => !!row).map((row) => row.write_id);
  const changes = items
    .filter((event) => !ownWriteOf(event))
    .flatMap((event) => {
      const kind = classifyChange(event, now);
      return kind ? [{ event, kind }] : [];
    });

  let notified = changes.length;
  if (changes.length > BULK_THRESHOLD) {
    const starts = changes.map(({ event }) => event.start?.dateTime).filter((s): s is string => !!s).sort();
    await deps.notify(bulkNotice(householdId, changes.length, starts[0], fromToken));
    notified = 1;
  } else {
    for (const { event, kind } of changes) await deps.notify(changeNotice(householdId, event, kind));
  }
  // 通知を送り終えてから消す。失敗して読み直すときも、自分の変更と分かるように
  if (matched.length > 0) await deps.store.consumeOwnWrites(householdId, matched);
  return notified;
}

// 認証の失敗はすぐ、一時的な失敗は 10 分続いたら接続を error にして1回だけ通知する
async function recordFailure(connection: CalendarConnection, e: unknown, now: Date, deps: SyncDeps): Promise<SyncResult> {
  const householdId = connection.household_id;
  const message = e instanceof Error ? e.message : String(e);
  console.error("calendar sync failed", householdId, message);
  const since = Date.parse(connection.last_synced_at ?? "");
  const transient = e instanceof GoogleApiError && e.transient;
  const giveUp = !transient || Number.isNaN(since) || now.getTime() - since > TRANSIENT_ALERT_MS;
  const firstAlert = giveUp && connection.status === "active";
  try {
    await deps.store.updateConnection(householdId, {
      status: giveUp ? "error" : connection.status,
      last_error: message.slice(0, 500),
    });
    if (firstAlert) {
      await deps.notify({
        household_id: householdId,
        kind: "calendar_sync_failed",
        title: "予約先に接続できません",
        body: "Google カレンダーの予約を読めません。設定を確かめてください",
        data: {},
        dedupe_key: `calendar_sync_failed:${now.toISOString()}`,
      });
    }
  } catch (recordError) {
    console.error("calendar sync failure was not recorded", householdId, recordError);
  }
  return { household_id: householdId, outcome: "failed", notified: firstAlert ? 1 : 0, error: message };
}
