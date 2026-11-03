// 文を読み取る解析器の入口。解析器を替えるときは IntentParser を実装する（docs/reservations.md 9章）
import { addDays, tokyoDate, weekdayName, weekdayOf } from "./tokyo_time.ts";

export type ShopService = { name: string; duration_minutes: number };
export type BusinessHour = { day: number; closed: boolean; open: string | null; close: string | null };

export type IntentContext = {
  today: string;
  today_weekday: string;
  // 今日から先の日付と曜日の表。LLM が「来週の水曜」を計算しなくて済むように渡す
  calendar: { date: string; weekday: string }[];
  services: ShopService[];
  hours: BusinessHour[];
};

// 解析器の出力。LLM の値は信用しないので、型を決めずに受けて resolve で確かめる
export type ParsedIntent = {
  action: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  service_name?: unknown;
  note?: unknown;
  // 追加と変更の後の日時
  date?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  duration_minutes?: unknown;
  // 変更する予約の、今の日付
  target_date?: unknown;
  // 営業時間の変更
  weekday?: unknown;
  closed?: unknown;
  shop_open?: unknown;
  shop_close?: unknown;
};

export interface IntentParser {
  parse(text: string, context: IntentContext): Promise<ParsedIntent>;
}

// 「来週の水曜」まで読めるように2週間分を渡す
const CALENDAR_DAYS = 14;

export function buildContext(now: Date, services: ShopService[], hours: BusinessHour[]): IntentContext {
  const today = tokyoDate(now);
  return {
    today,
    today_weekday: weekdayName(weekdayOf(today)),
    calendar: Array.from({ length: CALENDAR_DAYS }, (_, i) => {
      const date = addDays(today, i);
      return { date, weekday: weekdayName(weekdayOf(date)) };
    }),
    services,
    hours,
  };
}
