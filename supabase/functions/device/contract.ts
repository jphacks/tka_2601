// 本体と中継（ボイスエージェント）に渡す形。ボイスエージェントの仕様が変わったらここを直す
// （docs/reservations.md 3.2、9章）。handler.ts はこの変換を使うだけにする
import {
  type NewReservation,
  parseNewReservation,
  type ProviderKind,
  type Reservation,
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

export function settingsBody(device: DeviceSettings, shop: unknown) {
  return {
    contract_version: CONTRACT_VERSION,
    paired: device.household_id !== null,
    mode: device.mode,
    away_leave_at_door: device.away_leave_at_door,
    auto_away: device.auto_away,
    extra_instructions: device.extra_instructions,
    shop: shopFields(shop),
  };
}

function reservationFields(reservation: Reservation) {
  return {
    id: reservation.id,
    customer_name: reservation.customer_name,
    customer_phone: reservation.customer_phone,
    service_name: reservation.service_name,
    starts_at: reservation.starts_at,
    ends_at: reservation.ends_at,
    status: reservation.status,
    source: reservation.source,
    note: reservation.note,
    arrived_at: reservation.arrived_at,
    visit_id: reservation.visit_id,
    read_only: reservation.read_only,
  };
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
