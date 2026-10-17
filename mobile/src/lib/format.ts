const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const pad = (n: number) => String(n).padStart(2, '0');

// 10月17日（土）
export function monthDay(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
}

// 一覧の日付の見出し。今日と昨日は頭に付ける
export function sectionTitle(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `今日　${monthDay(date)}`;
  if (days === 1) return `昨日　${monthDay(date)}`;
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
