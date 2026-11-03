// 東京の日付と時刻の計算。日本に夏時間はないので +09:00 で固定する
const OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function weekdayName(day: number): string {
  return WEEKDAYS[day];
}

// 2026-11-02
export function tokyoDate(time: Date): string {
  return new Date(time.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

// 14:00
export function tokyoTime(time: Date): string {
  return new Date(time.getTime() + OFFSET_MS).toISOString().slice(11, 16);
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// 東京の日付と時刻を ISO 8601（UTC）に直す
export function tokyoIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

// 日曜が 0
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// 11月4日（水）
export function monthDayLabel(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${month}月${day}日（${weekdayName(weekdayOf(date))}）`;
}
