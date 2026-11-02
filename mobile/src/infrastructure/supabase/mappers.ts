// 通信の形からドメインへの変換。ボイスエージェントや Edge Function が知らない値を返しても、
// ここで丸めて画面を落とさない。形が変わったらここを直す
import type { AssistantProposal, DayHours, TimeSpan } from '../../domain/assistant';
import type { AppNotification } from '../../domain/notification';
import type { ProviderState, Reservation, ReservationProvider, ReservationSource, ReservationStatus } from '../../domain/reservation';
import type { BusinessHour, BusinessType, ShopProfile, Tone, WalkInPolicy } from '../../domain/shop';
import type { EndReason, Intent, Mode, Outcome, Speaker, Visit, VisitMessage, VisitStatus } from '../../domain/visit';

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// Record にすることで、値を足したときに型の試験で気づける
function oneOf<T extends string>(table: Record<T, true>, value: unknown, fallback: T): T {
  return typeof value === 'string' && value in table ? (value as T) : fallback;
}

function nullableOneOf<T extends string>(table: Record<T, true>, value: unknown, fallback: T | null): T | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value in table ? (value as T) : fallback;
}

const MODES: Record<Mode, true> = { normal: true, omakase: true, away: true, off: true };
const VISIT_STATUSES: Record<VisitStatus, true> = { ringing: true, in_call: true, ended: true, missed: true };
const INTENTS: Record<Intent, true> = {
  delivery: true,
  sales: true,
  service: true,
  acquaintance: true,
  emergency: true,
  unknown: true,
};
const OUTCOMES: Record<Outcome, true> = {
  leave_at_door: true,
  delivery_slip: true,
  declined: true,
  callback: true,
  escalated: true,
  none: true,
};
const END_REASONS: Record<EndReason, true> = {
  closing: true,
  silence: true,
  time_limit: true,
  fallback: true,
  safe: true,
  mode_off: true,
  resident: true,
  no_answer: true,
};
const SPEAKERS: Record<Speaker, true> = { visitor: true, ai: true, canned: true };

export function toVisit(row: Row): Visit {
  return {
    id: text(row.id),
    household_id: text(row.household_id),
    device_id: text(row.device_id),
    mode: oneOf(MODES, row.mode, 'normal'),
    chimed_at: text(row.chimed_at),
    answered_at: nullableText(row.answered_at),
    ended_at: nullableText(row.ended_at),
    // 知らない状態は、進行中に見せ続けないよう終わったものとして扱う
    status: oneOf(VISIT_STATUSES, row.status, 'ended'),
    intent: nullableOneOf(INTENTS, row.intent, 'unknown'),
    company: nullableText(row.company),
    outcome: nullableOneOf(OUTCOMES, row.outcome, 'none'),
    end_reason: nullableOneOf(END_REASONS, row.end_reason, null),
  };
}

export function toVisitMessage(row: Row): VisitMessage {
  return {
    visit_id: text(row.visit_id),
    seq: typeof row.seq === 'number' ? row.seq : 0,
    speaker: oneOf(SPEAKERS, row.speaker, 'ai'),
    text: text(row.text),
    spoken_at: nullableText(row.spoken_at),
  };
}

const PROVIDERS: Record<ReservationProvider, true> = { monban: true, google_calendar: true, square: true, hotpepper: true };
const RESERVATION_STATUSES: Record<ReservationStatus, true> = { pending: true, confirmed: true, cancelled: true };
const SOURCES: Record<ReservationSource, true> = { app: true, ai: true, external: true };

export function toReservationProvider(value: unknown): ReservationProvider {
  return oneOf(PROVIDERS, value, 'monban');
}

export function toReservation(row: Row): Reservation {
  return {
    id: text(row.id),
    customer_name: text(row.customer_name),
    customer_phone: nullableText(row.customer_phone),
    service_name: nullableText(row.service_name),
    starts_at: text(row.starts_at),
    ends_at: text(row.ends_at),
    // 知らない状態は、店の確認が要るものとして仮予約に寄せる
    status: oneOf(RESERVATION_STATUSES, row.status, 'pending'),
    source: oneOf(SOURCES, row.source, 'external'),
    note: nullableText(row.note),
    arrived_at: nullableText(row.arrived_at),
    visit_id: nullableText(row.visit_id),
    read_only: row.read_only === true,
  };
}

function toConnectionStatus(value: unknown): 'active' | 'error' | null {
  return value === 'active' || value === 'error' ? value : null;
}

export function toProviderState(row: Row): ProviderState {
  const google = isRow(row.google) ? row.google : {};
  const square = isRow(row.square) ? row.square : {};
  const capabilities = isRow(row.capabilities) ? row.capabilities : {};
  return {
    provider: toReservationProvider(row.provider),
    capabilities: { create: capabilities.create !== false },
    google: {
      connected: google.connected === true,
      account_email: nullableText(google.account_email),
      calendar_id: nullableText(google.calendar_id),
      calendar_name: nullableText(google.calendar_name),
      status: toConnectionStatus(google.status),
      last_error: nullableText(google.last_error),
    },
    square: {
      connected: square.connected === true,
      merchant_name: nullableText(square.merchant_name),
      status: toConnectionStatus(square.status),
      last_error: nullableText(square.last_error),
    },
  };
}

const BUSINESS_TYPES: Record<BusinessType, true> = { nail_salon: true, massage: true, cram_school: true, other: true };
const TONES: Record<Tone, true> = { very_polite: true, polite: true, friendly: true };
const WALK_INS: Record<WalkInPolicy, true> = { take_reservation: true, notify_shop: true, decline: true };

function toBusinessHour(value: unknown): BusinessHour | null {
  if (!isRow(value) || typeof value.day !== 'number') return null;
  return {
    day: value.day,
    closed: value.closed === true,
    open: text(value.open, '10:00'),
    close: text(value.close, '19:00'),
  };
}

export function toShopProfile(row: Row): ShopProfile {
  const hours = Array.isArray(row.business_hours) ? row.business_hours : [];
  return {
    household_id: text(row.household_id),
    business_type: oneOf(BUSINESS_TYPES, row.business_type, 'other'),
    tone: oneOf(TONES, row.tone, 'very_polite'),
    greeting: text(row.greeting),
    business_hours: hours.map(toBusinessHour).filter((hour): hour is BusinessHour => hour !== null),
    walk_in_policy: oneOf(WALK_INS, row.walk_in_policy, 'take_reservation'),
    reservation_provider: toReservationProvider(row.reservation_provider),
  };
}

export function toNotification(row: Row): AppNotification {
  return {
    id: text(row.id),
    kind: text(row.kind),
    title: text(row.title),
    body: text(row.body),
    data: isRow(row.data) ? row.data : {},
    actor_user_id: nullableText(row.actor_user_id),
    created_at: text(row.created_at),
  };
}

function toWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toTimeSpan(value: unknown): TimeSpan | null {
  if (!isRow(value) || typeof value.starts_at !== 'string' || typeof value.ends_at !== 'string') return null;
  return { starts_at: value.starts_at, ends_at: value.ends_at };
}

function toDayHours(value: unknown): DayHours | null {
  if (!isRow(value)) return null;
  return { closed: value.closed === true, open: text(value.open), close: text(value.close) };
}

const UNREADABLE: AssistantProposal = { type: 'unknown', reason: '', warnings: [] };

// 案の形が崩れていたら、書き込みに進ませず読み取れなかったものとして扱う
export function toAssistantProposal(value: unknown): AssistantProposal {
  if (!isRow(value)) return UNREADABLE;
  const warnings = toWarnings(value.warnings);
  switch (value.type) {
    case 'add_reservation': {
      const span = toTimeSpan(value);
      if (!span || typeof value.customer_name !== 'string' || !value.customer_name) return UNREADABLE;
      return {
        type: 'add_reservation',
        ...span,
        customer_name: value.customer_name,
        customer_phone: nullableText(value.customer_phone),
        service_name: nullableText(value.service_name),
        note: nullableText(value.note),
        warnings,
      };
    }
    case 'update_reservation': {
      const before = toTimeSpan(value.before);
      const after = toTimeSpan(value.after);
      if (!before || !after || typeof value.reservation_id !== 'string' || !value.reservation_id) return UNREADABLE;
      return {
        type: 'update_reservation',
        reservation_id: value.reservation_id,
        customer_name: text(value.customer_name),
        service_name: nullableText(value.service_name),
        before,
        after,
        warnings,
      };
    }
    case 'set_business_hours': {
      const before = toDayHours(value.before);
      const after = toDayHours(value.after);
      const day = value.day;
      if (!before || !after || typeof day !== 'number' || day < 0 || day > 6) return UNREADABLE;
      return { type: 'set_business_hours', day, before, after, warnings };
    }
    case 'unknown':
      return { type: 'unknown', reason: text(value.reason), warnings };
    default:
      return UNREADABLE;
  }
}
