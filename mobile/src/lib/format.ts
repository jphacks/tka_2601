const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');

// 水曜日
export function weekdayName(day: number): string {
  return `${WEEKDAYS[day]}曜日`;
}

// 10月17日（土）
export function monthDay(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
}

// 一覧の日付の見出し。今日、昨日、明日は頭に付ける
export function sectionTitle(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `今日　${monthDay(date)}`;
  if (days === 1) return `昨日　${monthDay(date)}`;
  if (days === -1) return `明日　${monthDay(date)}`;
  return monthDay(date);
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// 14:32、9:02
export function hourMinute(date: Date): string {
  return `${date.getHours()}:${pad(date.getMinutes())}`;
}

// 14:32:07
export function hourMinuteSecond(date: Date): string {
  return `${hourMinute(date)}:${pad(date.getSeconds())}`;
}

export function callSeconds(answeredAt: string | null, endedAt: string | null): number | null {
  if (!answeredAt || !endedAt) return null;
  const seconds = Math.round((new Date(endedAt).getTime() - new Date(answeredAt).getTime()) / 1000);
  return seconds >= 0 ? seconds : null;
}

// 24秒、1分5秒
export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

// 14:30〜16:00
export function timeRange(startsAt: string, endsAt: string): string {
  return `${hourMinute(new Date(startsAt))}〜${hourMinute(new Date(endsAt))}`;
}

// ¥8,000
export function yen(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`;
}

// 90分
export function minutesLabel(minutes: number): string {
  return `${minutes}分`;
}

// 11月2日（月）14:00〜15:30
export function dateTimeRange(startsAt: string, endsAt: string): string {
  return `${monthDay(new Date(startsAt))}${timeRange(startsAt, endsAt)}`;
}

// 分を 10:00 の形に。0 時から 24 時の間に収める
// 予約の終了の時刻。翌日に入るときは 翌 0:30 と出す
export function endClockLabel(minutes: number): string {
  if (minutes < 24 * 60) return clockLabel(minutes);
  const rest = minutes - 24 * 60;
  return `翌 ${Math.floor(rest / 60)}:${pad(rest % 60)}`;
}

export function clockLabel(minutes: number): string {
  const clamped = Math.min(Math.max(minutes, 0), 24 * 60);
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

// 10:00 を 0 時からの分に。読めなければ fallback
export function clockMinutes(text: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}
