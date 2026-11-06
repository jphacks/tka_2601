// 本体と中継（ボイスエージェント）に渡す形。ボイスエージェントの仕様が変わったらここを直す
// （docs/reservations.md 3.2、9章）。handler.ts はこの変換を使うだけにする
import {
  type NewReservation,
  parseNewReservation,
  parseRange,
  ProviderError,
  type ProviderKind,
  type Reservation,
  type ReservationRange,
} from "../_shared/reservation.ts";

// 形を壊す変更をしたら上げる。中継はこの値で読み方を切り替えられる
export const CONTRACT_VERSION = 1;

export type DeviceSettings = {
  household_id: string | null;
  mode: string;
  away_leave_at_door: boolean;
  auto_away: boolean;
  extra_instructions: string;
};

// device_shop_profile の結果から、渡す項目だけを選ぶ
function shopFields(shop: unknown): unknown {
  if (typeof shop !== "object" || shop === null) return null;
  const s = shop as Record<string, unknown>;
  return {
    name: s.name,
    business_type: s.business_type,
    tone: s.tone,
    greeting: s.greeting,
    business_hours: s.business_hours,
    walk_in_policy: s.walk_in_policy,
    reservation_provider: s.reservation_provider,
    services: s.services,
  };
}

export function settingsBody(device: DeviceSettings, shop: unknown, pusherSettings: unknown = null) {
  return {
    contract_version: CONTRACT_VERSION,
    paired: device.household_id !== null,
    mode: device.mode,
    away_leave_at_door: device.away_leave_at_door,
    auto_away: device.auto_away,
    extra_instructions: device.extra_instructions,
    shop: shopFields(shop),
    pusher_settings: pusherSettings,
  };
}

// The firmware polls this often and reads it into a small buffer, so it gets
// the household mode only. An unpaired device has no household mode to follow.
export function modeSettingsBody(device: DeviceSettings) {
  const paired = device.household_id !== null;
  return {
    contract_version: CONTRACT_VERSION,
    paired,
    mode: paired ? device.mode : null,
  };
}

export type PusherConfig = {
  schema_version: 1;
  enabled_pushers: ["p1"] | ["p2"] | ["p1", "p2"];
  assignments: { call_start: "p1" | "p2"; call_end: "p1" | "p2" };
};

// Firmware reads only desired state. Shop data and reported device state can be
// much larger than its bounded HTTP response buffer.
export function pusherSettingsBody(device: DeviceSettings, settings: unknown) {
  return {
    contract_version: CONTRACT_VERSION,
    paired: device.household_id !== null,
    pusher_settings: isObject(settings) ? {
      desired_revision: settings.desired_revision,
      desired_config: settings.desired_config,
    } : null,
  };
}

export function isPusherConfig(value: unknown): value is PusherConfig {
  if (!isObject(value) || value.schema_version !== 1 ||
    Object.keys(value).some((key) => !["schema_version", "enabled_pushers", "assignments"].includes(key))) return false;
  const enabled = value.enabled_pushers;
  const assignments = value.assignments;
  if (!Array.isArray(enabled) || !isObject(assignments) ||
    Object.keys(assignments).some((key) => !["call_start", "call_end"].includes(key))) return false;
  const start = assignments.call_start, end = assignments.call_end;
  if (typeof start !== "string" || typeof end !== "string") return false;
  return (enabled.length === 1 && ["p1", "p2"].includes(enabled[0]) && start === enabled[0] && end === enabled[0]) ||
    (enabled.length === 2 && enabled[0] === "p1" && enabled[1] === "p2" &&
      ["p1", "p2"].includes(start) && ["p1", "p2"].includes(end) && start !== end);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePusherStatus(body: Record<string, unknown>) {
  const revision = body.applied_revision;
  const config = body.applied_config;
  const error = body.apply_error;
  const runtime = body.runtime_status;
  const capabilities = body.capabilities;
  if ((revision !== null && (!Number.isInteger(revision) || typeof revision !== "number" || revision < 0 || revision > 4294967295)) ||
    (revision === null ? config !== null : !isPusherConfig(config)) ||
    (error !== null && (typeof error !== "string" || error.length < 1 || error.length > 128)) ||
    (runtime !== null && runtime !== "normal" && runtime !== "manual_check_required") ||
    (capabilities !== null && (!isObject(capabilities) || new TextEncoder().encode(JSON.stringify(capabilities)).length > 4096))) {
    throw new ProviderError(400, "プッシャー適用結果が正しくありません");
  }
  return {
    p_applied_revision: revision as number | null,
    p_applied_config: config as PusherConfig | null,
    p_apply_error: error as string | null,
    p_runtime_status: runtime as string | null,
    p_capabilities: capabilities,
  };
}

// 本体の鍵で読める範囲を絞る。電話番号とメモは渡さない。メモは予約先で外部の人が書けるので、LLM にも渡さない
function reservationFields(reservation: Reservation) {
  return {
    id: reservation.id,
    customer_name: reservation.customer_name,
    service_name: reservation.service_name,
    starts_at: reservation.starts_at,
    ends_at: reservation.ends_at,
    status: reservation.status,
    source: reservation.source,
    arrived_at: reservation.arrived_at,
    visit_id: reservation.visit_id,
    read_only: reservation.read_only,
  };
}

const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

// 一度に読める期間は 31 日まで
export function parseDeviceRange(params: URLSearchParams): ReservationRange {
  const range = parseRange(params);
  if (Date.parse(range.to) - Date.parse(range.from) > MAX_RANGE_MS) {
    throw new ProviderError(400, "期間は 31 日までにしてください");
  }
  return range;
}

export function reservationListBody(provider: ProviderKind, reservations: Reservation[]) {
  return { provider, reservations: reservations.map(reservationFields) };
}

export function reservationBody(reservation: Reservation) {
  return { reservation: reservationFields(reservation) };
}

// AI が受けた予約は必ず仮予約にする。visit_id は呼ぶ側が店のものか確かめてから結び付ける
export function parseAiReservation(body: Record<string, unknown>): { input: NewReservation; visitId: string | null } {
  return {
    input: parseNewReservation(body, { status: "pending", source: "ai" }),
    visitId: typeof body.visit_id === "string" ? body.visit_id : null,
  };
}

const VISIT_FIELDS = [
  "chimed_at",
  "mode",
  "status",
  "answered_at",
  "ended_at",
  "end_reason",
  "intent",
  "company",
  "outcome",
] as const;

export function visitFields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(VISIT_FIELDS.filter((f) => f in body).map((f) => [f, body[f]]));
}
