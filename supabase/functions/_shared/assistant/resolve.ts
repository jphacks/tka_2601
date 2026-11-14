// 解析器の出力を案に変換する。LLM の値は信用せず、ここで型と範囲を確かめる。
// 読むのは予約先だけで、書き込みはしない
import { findOverlaps, type Reservation, type ReservationProvider } from "../reservation.ts";
import type { BusinessHour, IntentContext, ParsedIntent, ShopService } from "./intent_parser.ts";
import {
  type AssistantProposal,
  cleanName,
  cleanNote,
  cleanPhone,
  cleanService,
  type DayHours,
  unknownProposal,
} from "./proposal.ts";
import { addDays, isValidDate, isValidTime, monthDayLabel, tokyoDate, tokyoIso, tokyoTime, weekdayOf } from "./tokyo_time.ts";

const DEFAULT_MINUTES = 60;
const MIN_MINUTES = 5;
const MAX_MINUTES = 720;
const SEARCH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const DATE_MISMATCH = "日付を読み取れませんでした。11月9日のように書いてください";

export type ResolveInput = {
  // 店の人が書いた文。LLM の読み取りを文と突き合わせて確かめるために使う
  text: string;
  intent: ParsedIntent;
  context: IntentContext;
  provider: ReservationProvider;
  now: Date;
};

export function resolveIntent(rawInput: ResolveInput): Promise<AssistantProposal> {
  // 文に長さが書かれていないのに LLM が補った所要時間は使わない
  const input = mentionsLength(rawInput.text)
    ? rawInput
    : { ...rawInput, intent: { ...rawInput.intent, duration_minutes: null } };
  switch (input.intent.action) {
    case "add":
      return resolveAdd(input);
    case "update":
      return resolveUpdate(input);
    case "set_hours":
      return resolveHours(input);
    default:
      return Promise.resolve(unknownProposal("読み取れませんでした"));
  }
}

async function resolveAdd({ text, intent, context, provider, now }: ResolveInput): Promise<AssistantProposal> {
  if (provider.kind === "square") return unknownProposal("Square 予約の予約は Square で追加してください");
  const name = cleanName(intent.customer_name);
  if (!name) return unknownProposal("お客様の名前を読み取れませんでした");
  const startTime = isValidTime(intent.start_time) ? intent.start_time : timesInText(text)[0];
  if (!isValidDate(intent.date) || !startTime) return unknownProposal("日時を読み取れませんでした");
  if (!dateFitsText(intent.date, text, context.today)) return unknownProposal(DATE_MISMATCH);

  const startsAt = tokyoIso(intent.date, startTime);
  if (Date.parse(startsAt) <= now.getTime()) return unknownProposal("過去の日時は指定できません");

  const service = matchService(intent.service_name, context.services) ?? serviceInText(text, context.services);
  const endsAt = resolveEnd(intent, startsAt, service?.duration_minutes ?? DEFAULT_MINUTES);
  return {
    type: "add_reservation",
    customer_name: name,
    customer_phone: cleanPhone(intent.customer_phone),
    service_name: service?.name ?? cleanService(intent.service_name),
    starts_at: startsAt,
    ends_at: endsAt,
    note: cleanNote(intent.note),
    warnings: await slotWarnings(provider, context.hours, startsAt, endsAt),
  };
}

async function resolveUpdate({ text, intent, context, provider, now }: ResolveInput): Promise<AssistantProposal> {
  const name = cleanName(intent.customer_name);
  if (!name) return unknownProposal("お客様の名前を読み取れませんでした");
  const hasTargetDate = isValidDate(intent.target_date);
  if (intent.target_date != null && !hasTargetDate) return unknownProposal("予約の日付を読み取れませんでした");
  if (hasTargetDate && !dateFitsText(intent.target_date as string, text, context.today)) return unknownProposal(DATE_MISMATCH);

  const range = hasTargetDate
    ? { from: tokyoIso(intent.target_date as string, "00:00"), to: tokyoIso(addDays(intent.target_date as string, 1), "00:00") }
    : { from: now.toISOString(), to: new Date(now.getTime() + SEARCH_DAYS * DAY_MS).toISOString() };
  const matches = (await provider.list(range)).filter((r) => normalize(r.customer_name).includes(normalize(name)));
  if (matches.length === 0) return unknownProposal(`${name}様の予約が見つかりませんでした`);
  if (matches.length > 1) return unknownProposal(`${name}様の予約が${matches.length}件あります。日付も書いてください`);

  const target = matches[0];
  if (target.read_only) return unknownProposal("この予約は予約先で変更してください");

  const hasDate = isValidDate(intent.date);
  // 変更後の時刻は文の後ろに書かれる（「14時の予約を15時半に」）
  const startTime = isValidTime(intent.start_time) ? intent.start_time : timesInText(text).at(-1);
  const hasStart = startTime !== undefined;
  const keepsLength = intent.end_time == null && intent.duration_minutes == null;
  if (!hasDate && !hasStart && keepsLength) return unknownProposal("変更後の日時を読み取れませんでした");
  if (hasDate && !dateFitsText(intent.date as string, text, context.today)) return unknownProposal(DATE_MISMATCH);

  const current = new Date(target.starts_at);
  const startsAt = tokyoIso(
    hasDate ? intent.date as string : tokyoDate(current),
    startTime ?? tokyoTime(current),
  );
  const currentMinutes = (Date.parse(target.ends_at) - Date.parse(target.starts_at)) / 60_000;
  const endsAt = resolveEnd(intent, startsAt, currentMinutes);
  if (Date.parse(startsAt) <= now.getTime()) return unknownProposal("過去の日時は指定できません");
  if (startsAt === new Date(target.starts_at).toISOString() && endsAt === new Date(target.ends_at).toISOString()) {
    return unknownProposal("今の予約と同じ日時です");
  }
  return {
    type: "update_reservation",
    reservation_id: target.id,
    customer_name: target.customer_name,
    service_name: target.service_name,
    before: { starts_at: target.starts_at, ends_at: target.ends_at },
    after: { starts_at: startsAt, ends_at: endsAt },
    warnings: await slotWarnings(provider, context.hours, startsAt, endsAt, target.id),
  };
}

async function resolveHours({ intent, context, provider, now }: ResolveInput): Promise<AssistantProposal> {
  const day = intent.weekday;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
    return unknownProposal("曜日を読み取れませんでした");
  }
  const current = context.hours.find((h) => h.day === day);
  const before: DayHours = current
    ? { closed: current.closed, open: current.open, close: current.close }
    : { closed: false, open: null, close: null };
  const after = nextHours(intent, before);
  if (!after) return unknownProposal("開店と閉店の時刻を読み取れませんでした");
  if (after.open !== null && after.close !== null && after.open >= after.close) {
    return unknownProposal("閉店は開店より後にしてください");
  }
  if (after.closed === before.closed && (after.closed || (after.open === before.open && after.close === before.close))) {
    return unknownProposal("今の営業時間と同じです");
  }
  return {
    type: "set_business_hours",
    day,
    before,
    after,
    warnings: await remainingWarnings(provider, day, after, now),
  };
}

// 定休日にしても開店と閉店の時刻は残し、営業に戻すときに使えるようにする
function nextHours(intent: ParsedIntent, before: DayHours): DayHours | null {
  if (intent.closed === true) return { ...before, closed: true };
  const open = intent.shop_open == null ? before.open : intent.shop_open;
  const close = intent.shop_close == null ? before.close : intent.shop_close;
  if (!isValidTime(open) || !isValidTime(close)) return null;
  return { closed: false, open, close };
}

// 終了の決め方: 終了時刻、所要時間、渡された既定の分数の順
function resolveEnd(intent: ParsedIntent, startsAt: string, fallbackMinutes: number): string {
  if (isValidTime(intent.end_time)) {
    const end = tokyoIso(tokyoDate(new Date(startsAt)), intent.end_time);
    if (Date.parse(end) > Date.parse(startsAt)) return end;
  }
  const minutes = validMinutes(intent.duration_minutes) ?? fallbackMinutes;
  return new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
}

function validMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES ? value : null;
}

// 完全に一致するものを優先し、なければ部分一致が1つのときだけ採る
function matchService(value: unknown, services: ShopService[]): ShopService | null {
  const name = cleanService(value);
  if (!name) return null;
  const wanted = normalize(name);
  const exact = services.find((s) => normalize(s.name) === wanted);
  if (exact) return exact;
  const partial = services.filter((s) => normalize(s.name).includes(wanted) || wanted.includes(normalize(s.name)));
  return partial.length === 1 ? partial[0] : null;
}

// LLM が読み取りを落としても、メニュー名がそのまま書かれていれば拾う
function serviceInText(text: string, services: ShopService[]): ShopService | null {
  const wanted = normalize(text);
  const found = services.filter((s) => wanted.includes(normalize(s.name)));
  return found.length === 1 ? found[0] : null;
}

// 文に書かれた時刻を順に返す。LLM が時刻を落としたときに使う
function timesInText(text: string): string[] {
  // 「2時間」は長さなので時刻として読まない
  const pattern = /(午前|午後)?\s*(\d{1,2})(?:時(?!間)(半|(\d{1,2})分)?|:(\d{2}))/g;
  const times: string[] = [];
  for (const m of text.normalize("NFKC").matchAll(pattern)) {
    const hour = Number(m[2]) + (m[1] === "午後" && Number(m[2]) < 12 ? 12 : 0);
    const minute = m[3] === "半" ? 30 : Number(m[4] ?? m[5] ?? 0);
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (isValidTime(time)) times.push(time);
  }
  return times;
}

function mentionsLength(text: string): boolean {
  return /分|時間/.test(text);
}

// 文に曜日や「明日」が書かれていれば、読み取った日付がそれに合うかを確かめる。
// LLM は「来週月曜」を別の曜日の日付にすることがあるため、合わなければ案を出さない
function dateFitsText(date: string, text: string, today: string): boolean {
  const weekdays = [...text.matchAll(/([日月火水木金土])曜/g)].map((m) => WEEKDAYS.indexOf(m[1]));
  const relative: string[] = [];
  if (/今日|本日|きょう/.test(text)) relative.push(today);
  if (/明日|あした|あす/.test(text)) relative.push(addDays(today, 1));
  if (/明後日|あさって/.test(text)) relative.push(addDays(today, 2));
  if (weekdays.length === 0 && relative.length === 0) return true;
  return weekdays.includes(weekdayOf(date)) || relative.includes(date);
}

function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s/g, "").toLowerCase();
}

async function slotWarnings(
  provider: ReservationProvider,
  hours: BusinessHour[],
  startsAt: string,
  endsAt: string,
  excludeId?: string,
): Promise<string[]> {
  const warnings = (await findOverlaps(provider, startsAt, endsAt, excludeId)).map(overlapWarning);
  const date = tokyoDate(new Date(startsAt));
  if (hours.find((h) => h.day === weekdayOf(date))?.closed) warnings.push(`${monthDayLabel(date)}は定休日です`);
  return warnings;
}

// 16:30〜の山本様と重なります。Google カレンダーで直接作られた予定は件名をそのまま出す
function overlapWarning(reservation: Reservation): string {
  const name = reservation.source === "external" ? reservation.customer_name : `${reservation.customer_name}様`;
  return `${tokyoTime(new Date(reservation.starts_at))}〜の${name}と重なります`;
}

// 変更の後も営業時間から外れたまま残る、向こう 30 日の予約を日付ごとに知らせる
async function remainingWarnings(provider: ReservationProvider, day: number, after: DayHours, now: Date): Promise<string[]> {
  const reservations = await provider.list({
    from: now.toISOString(),
    to: new Date(now.getTime() + SEARCH_DAYS * DAY_MS).toISOString(),
  });
  const counts = new Map<string, number>();
  for (const reservation of reservations) {
    const start = new Date(reservation.starts_at);
    const date = tokyoDate(start);
    if (weekdayOf(date) !== day || !isOutside(reservation, after)) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => `${monthDayLabel(date)}の予約 ${count}件は残ります`);
}

function isOutside(reservation: Reservation, after: DayHours): boolean {
  if (after.closed) return true;
  const start = tokyoTime(new Date(reservation.starts_at));
  const end = tokyoTime(new Date(reservation.ends_at));
  return start < (after.open as string) || end > (after.close as string);
}
