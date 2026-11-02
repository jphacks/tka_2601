// 予約。どの予約先でも同じ形（docs/reservations.md 3.1）
export type ReservationProvider = 'monban' | 'google_calendar' | 'square' | 'hotpepper';
export type ReservationStatus = 'pending' | 'confirmed' | 'cancelled';
export type ReservationSource = 'app' | 'ai' | 'external';

// id は予約帳なら uuid、Google なら予定の id、Square なら square: で始まる
export type Reservation = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  service_name: string | null;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
  source: ReservationSource;
  note: string | null;
  arrived_at: string | null;
  visit_id: string | null;
  // 予約先でしか変えられない予約（Square の予約）。到着の記録だけはできる
  read_only: boolean;
};

export type ReservationInput = Pick<
  Reservation,
  'customer_name' | 'customer_phone' | 'service_name' | 'starts_at' | 'ends_at' | 'note'
>;

export type ConnectionStatus = 'active' | 'error' | null;

export type ProviderState = {
  provider: ReservationProvider;
  capabilities: { create: boolean };
  google: {
    connected: boolean;
    account_email: string | null;
    calendar_id: string | null;
    calendar_name: string | null;
    status: ConnectionStatus;
    last_error: string | null;
  };
  square: {
    connected: boolean;
    merchant_name: string | null;
    status: ConnectionStatus;
    last_error: string | null;
  };
};

export type GoogleCalendar = { id: string; name: string; primary: boolean };

// 承認リストの期間
export const PENDING_RANGE_DAYS = 90;
// 一覧で先まで見る日数
export const LIST_RANGE_DAYS = 60;

// 2026-11-2 の形
export function calendarDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function startOfDayDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function isSameDay(a: Date, b: Date): boolean {
  return calendarDayKey(a) === calendarDayKey(b);
}

export type DateRange = { from: Date; to: Date };

export function dayRange(date: Date): DateRange {
  const from = startOfDayDate(date);
  return { from, to: addDays(from, 1) };
}

// 週は日曜始まり
export function weekRange(date: Date): DateRange {
  const from = addDays(date, -date.getDay());
  return { from, to: addDays(from, 7) };
}

export function monthRange(date: Date): DateRange {
  return {
    from: new Date(date.getFullYear(), date.getMonth(), 1),
    to: new Date(date.getFullYear(), date.getMonth() + 1, 1),
  };
}

// 日曜始まりの月の行数
export function monthWeekCount(date: Date): number {
  const first = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
  const days = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return Math.ceil((first + days) / 7);
}

export function datesInRange({ from, to }: DateRange): Date[] {
  const dates: Date[] = [];
  for (let date = from; date < to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function byStart(a: Reservation, b: Reservation): number {
  return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
}

// キャンセルを除いて、日ごとに開始の早い順にまとめる
export function reservationsByDay(reservations: readonly Reservation[]): Map<string, Reservation[]> {
  const days = new Map<string, Reservation[]>();
  for (const reservation of [...reservations].sort(byStart)) {
    if (reservation.status === 'cancelled') continue;
    const key = calendarDayKey(new Date(reservation.starts_at));
    const rows = days.get(key);
    if (rows) rows.push(reservation);
    else days.set(key, [reservation]);
  }
  return days;
}

// 一覧の見出しと行。日付の早い順
export function reservationSections(reservations: readonly Reservation[]): { date: Date; data: Reservation[] }[] {
  return [...reservationsByDay(reservations).values()].map((data) => ({
    date: startOfDayDate(new Date(data[0].starts_at)),
    data,
  }));
}

// 次に来る予約。確定していて、まだ到着しておらず、終わっていないもののうち最も早いもの
export function nextReservation(reservations: readonly Reservation[], now: Date): Reservation | null {
  return (
    [...reservations]
      .sort(byStart)
      .find(
        (reservation) =>
          reservation.status === 'confirmed' &&
          !reservation.arrived_at &&
          new Date(reservation.ends_at).getTime() > now.getTime(),
      ) ?? null
  );
}

// お客様の呼び方。Google カレンダーの件名など、外部の文字はそのまま出す
export function customerLabel(reservation: Pick<Reservation, 'customer_name' | 'source'>): string {
  return reservation.source === 'external' ? reservation.customer_name : `${reservation.customer_name}様`;
}
