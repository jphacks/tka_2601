// 店舗の設定（docs/reservations.md 5章）
import type { ReservationProvider } from './reservation';

export type BusinessType = 'nail_salon' | 'massage' | 'cram_school' | 'other';
export type Tone = 'very_polite' | 'polite' | 'friendly';
export type WalkInPolicy = 'take_reservation' | 'notify_shop' | 'decline';

// day は日曜が 0。open と close は 10:00 の形
export type BusinessHour = { day: number; closed: boolean; open: string; close: string };

export type ShopProfile = {
  household_id: string;
  business_type: BusinessType;
  tone: Tone;
  greeting: string;
  business_hours: BusinessHour[];
  walk_in_policy: WalkInPolicy;
  reservation_provider: ReservationProvider;
};

export type ShopProfilePatch = Partial<
  Pick<ShopProfile, 'business_type' | 'tone' | 'greeting' | 'business_hours' | 'walk_in_policy'>
>;

export type ShopService = {
  id: string;
  household_id: string;
  name: string;
  duration_minutes: number;
  price_yen: number | null;
  sort_order: number;
};

export type ServiceInput = Pick<ShopService, 'name' | 'duration_minutes' | 'price_yen'>;

const DEFAULT_OPEN = '10:00';
const DEFAULT_CLOSE = '19:00';

// 保存された営業時間を7曜日分にそろえる。未設定の曜日は営業日として既定の時刻を入れる
export function normalizeBusinessHours(saved: readonly Partial<BusinessHour>[]): BusinessHour[] {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const row = saved.find((item) => item.day === day);
    return {
      day,
      closed: row?.closed ?? false,
      open: row?.open ?? DEFAULT_OPEN,
      close: row?.close ?? DEFAULT_CLOSE,
    };
  });
}

// 定休日か。営業時間が未設定の店は定休日なしとして扱う
export function isClosedOn(hours: readonly BusinessHour[], date: Date): boolean {
  return hours.find((row) => row.day === date.getDay())?.closed ?? false;
}

function hourOf(clock: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  return match ? Number(match[1]) + Number(match[2]) / 60 : fallback;
}

// タイムラインに出す時間帯。営業時間と予約が収まる最小の幅で、最初と最後は時の区切りにする。
// lastHour は最後の行の開始の時（18 なら 19 時で終わる）
const DEFAULT_OPEN_HOUR = 10;
const DEFAULT_CLOSE_HOUR = 19;

export function visibleHours(
  hours: readonly BusinessHour[],
  dates: readonly Date[],
  reservations: readonly { starts_at: string; ends_at: string }[],
): { firstHour: number; lastHour: number } {
  let first = Infinity;
  let last = -Infinity;
  for (const date of dates) {
    const row = hours.find((item) => item.day === date.getDay());
    if (!row || row.closed) continue;
    first = Math.min(first, hourOf(row.open, 10));
    last = Math.max(last, hourOf(row.close, 19));
  }
  // 営業時間が決まっていない日も、空き時間を押せるように同じ幅で出す
  if (first === Infinity) {
    first = DEFAULT_OPEN_HOUR;
    last = DEFAULT_CLOSE_HOUR;
  }
  for (const reservation of reservations) {
    const start = new Date(reservation.starts_at);
    const end = new Date(reservation.ends_at);
    first = Math.min(first, start.getHours() + start.getMinutes() / 60);
    // 翌日にまたがる予定は 24 時で切る
    const endHour = end.getDate() === start.getDate() ? end.getHours() + end.getMinutes() / 60 : 24;
    last = Math.max(last, endHour);
  }
  // 閉店の時刻の行まで出す。出さないと最後の予約の下端が切れる
  const lastHour = Math.min(Math.max(Math.ceil(last), 1), 23);
  // カレンダーは最初の時が最後の時より前でないと動かない
  const firstHour = Math.min(Math.max(Math.floor(first), 0), lastHour - 1);
  return { firstHour, lastHour };
}
