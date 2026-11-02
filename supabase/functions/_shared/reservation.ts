// 予約先を問わない予約の形と、予約先の共通の入口（docs/reservations.md 2章・3章）

export type ProviderKind = "monban" | "google_calendar" | "square" | "hotpepper";
export type ReservationStatus = "pending" | "confirmed" | "cancelled";
export type ReservationSource = "app" | "ai" | "external";

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

export type NewReservation = {
  customer_name: string;
  customer_phone: string | null;
  service_name: string | null;
  starts_at: string;
  ends_at: string;
  note: string | null;
  status: "pending" | "confirmed";
  source: "app" | "ai";
  visit_id: string | null;
  // 送り直しても二重に作らないためのキー。アプリの追加だけが渡す
  idempotency_key?: string | null;
};

export type ReservationPatch = Partial<
  Pick<Reservation, "customer_name" | "customer_phone" | "service_name" | "starts_at" | "ends_at" | "note">
>;

export type ReservationRange = { from: string; to: string; status?: ReservationStatus };

// 変更する人が見ていた予約の時刻。今の予約と違えば変更しない
export type ExpectedVersion = { starts_at?: string; ends_at?: string };

// 書いた結果。dedupeKey は同じ版の予約を二重に通知しないためのキーを作る
export type ReservationWrite = {
  reservation: Reservation;
  dedupeKey: (kind: string) => string;
  // 同じ冪等キーの予約がすでにあった。新しく作っていないので通知しない
  existed?: boolean;
};

export interface ReservationProvider {
  readonly kind: ProviderKind;
  // 期間と重なる予約を開始の順に返す。status を渡さなければキャンセルを除く
  list(range: ReservationRange): Promise<Reservation[]>;
  get(id: string): Promise<Reservation | null>;
  create(input: NewReservation): Promise<ReservationWrite>;
  // 時間が重なれば 409（reservation_overlap）で作らない。AI の仮予約に使う
  createIfFree(input: NewReservation): Promise<ReservationWrite>;
  // expected を渡すと、今の予約と違うとき 409（reservation_changed）で変更しない
  update(id: string, patch: ReservationPatch, expected?: ExpectedVersion): Promise<ReservationWrite>;
  approve(id: string): Promise<ReservationWrite>;
  cancel(id: string): Promise<ReservationWrite>;
  arrive(id: string): Promise<ReservationWrite>;
}

// status と本文の error をそのまま返せる失敗
export class ProviderError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

// 時間が重なる予約。仮予約を含み、キャンセルは含まない。AI の予約と自然言語の案で同じ判定を使う
export async function findOverlaps(
  provider: Pick<ReservationProvider, "list">,
  startsAt: string,
  endsAt: string,
  excludeId?: string,
): Promise<Reservation[]> {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const found = await provider.list({ from: startsAt, to: endsAt });
  return found.filter((r) => r.id !== excludeId && Date.parse(r.starts_at) < end && Date.parse(r.ends_at) > start);
}

export const changedError = () =>
  new ProviderError(409, "予約が別の操作で変更されています。読み直してください", "reservation_changed");

export const overlapError = () => new ProviderError(409, "その時間にはすでに予約があります", "reservation_overlap");

// 予約先の種類から実装を選ぶ。予約帳とホットペッパーは同じ表を使う
export function selectProvider<T>(
  kind: ProviderKind,
  factories: { table: (kind: "monban" | "hotpepper") => T; google: () => T; square: () => T },
): T {
  if (kind === "google_calendar") return factories.google();
  if (kind === "square") return factories.square();
  return factories.table(kind);
}

const MAX_NAME = 60;
const MAX_PHONE = 30;
const MAX_SERVICE = 40;
const MAX_NOTE = 500;

function optionalText(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ProviderError(400, `${key} は文字列にしてください`);
  const text = value.trim();
  if (Array.from(text).length > max) throw new ProviderError(400, `${key} は ${max} 字までにしてください`);
  return text === "" ? null : text;
}

function requiredName(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new ProviderError(400, "customer_name を入れてください");
  if (Array.from(text).length > MAX_NAME) throw new ProviderError(400, `customer_name は ${MAX_NAME} 字までにしてください`);
  return text;
}

// オフセットのない日時は実行環境の時刻で解釈され、東京とずれて保存されるので受け付けない
const HAS_OFFSET = /T.*(?:Z|[+-]\d{2}:\d{2})$/i;

export function parseTime(value: unknown, key: string): string {
  const time = typeof value === "string" && HAS_OFFSET.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw new ProviderError(400, `${key} は Z か +09:00 の付いた ISO 8601 の日時にしてください`);
  return new Date(time).toISOString();
}

function checkOrder(startsAt: string, endsAt: string) {
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new ProviderError(400, "ends_at は starts_at より後にしてください");
  }
}

export function parseNewReservation(
  body: Record<string, unknown>,
  origin: { status: NewReservation["status"]; source: NewReservation["source"]; visit_id?: string | null },
): NewReservation {
  const startsAt = parseTime(body.starts_at, "starts_at");
  const endsAt = parseTime(body.ends_at, "ends_at");
  checkOrder(startsAt, endsAt);
  return {
    customer_name: requiredName(body.customer_name),
    customer_phone: optionalText(body, "customer_phone", MAX_PHONE),
    service_name: optionalText(body, "service_name", MAX_SERVICE),
    starts_at: startsAt,
    ends_at: endsAt,
    note: optionalText(body, "note", MAX_NOTE),
    status: origin.status,
    source: origin.source,
    visit_id: origin.visit_id ?? null,
  };
}

// 送られた項目だけを読む
export function parseReservationPatch(body: Record<string, unknown>): ReservationPatch {
  const patch: ReservationPatch = {};
  if ("customer_name" in body) patch.customer_name = requiredName(body.customer_name);
  if ("customer_phone" in body) patch.customer_phone = optionalText(body, "customer_phone", MAX_PHONE);
  if ("service_name" in body) patch.service_name = optionalText(body, "service_name", MAX_SERVICE);
  if ("note" in body) patch.note = optionalText(body, "note", MAX_NOTE);
  if ("starts_at" in body) patch.starts_at = parseTime(body.starts_at, "starts_at");
  if ("ends_at" in body) patch.ends_at = parseTime(body.ends_at, "ends_at");
  if (Object.keys(patch).length === 0) throw new ProviderError(400, "変更する項目を入れてください");
  return patch;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,64}$/;

export function parseIdempotencyKey(body: Record<string, unknown>): string | null {
  const value = body.idempotency_key;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new ProviderError(400, "idempotency_key は英数字とハイフンの 8〜64 字にしてください");
  }
  return value;
}

export function parseExpectedVersion(body: Record<string, unknown>): ExpectedVersion | undefined {
  const expected: ExpectedVersion = {};
  if (body.expected_starts_at !== undefined) expected.starts_at = parseTime(body.expected_starts_at, "expected_starts_at");
  if (body.expected_ends_at !== undefined) expected.ends_at = parseTime(body.expected_ends_at, "expected_ends_at");
  return Object.keys(expected).length > 0 ? expected : undefined;
}

export function checkExpectedVersion(current: Pick<Reservation, "starts_at" | "ends_at">, expected: ExpectedVersion | undefined) {
  if (!expected) return;
  const differs = (now: string, seen: string | undefined) => seen !== undefined && Date.parse(now) !== Date.parse(seen);
  if (differs(current.starts_at, expected.starts_at) || differs(current.ends_at, expected.ends_at)) throw changedError();
}

// 開始と終了の片方だけを変えたときも前後を確かめる
export function checkPatchedOrder(current: Reservation, patch: ReservationPatch) {
  checkOrder(patch.starts_at ?? current.starts_at, patch.ends_at ?? current.ends_at);
}

export function parseRange(params: URLSearchParams): ReservationRange {
  const from = parseTime(params.get("from"), "from");
  const to = parseTime(params.get("to"), "to");
  if (Date.parse(to) <= Date.parse(from)) throw new ProviderError(400, "to は from より後にしてください");
  const status = params.get("status");
  if (status !== null && status !== "pending" && status !== "confirmed" && status !== "cancelled") {
    throw new ProviderError(400, "status は pending、confirmed、cancelled のどれかにしてください");
  }
  return status === null ? { from, to } : { from, to, status };
}
