import type { Reservation, ReservationProvider, ReservationSource } from '../domain/reservation';
import type { BusinessType, Tone, WalkInPolicy } from '../domain/shop';
import type { EndReason, Intent, Mode, Outcome, Speaker, Visit } from '../domain/visit';

export const MODE_LABELS: Record<Mode, string> = {
  normal: '通常',
  omakase: 'おまかせ',
  away: '外出',
  off: '停止',
};

export const MODE_ORDER: Mode[] = ['normal', 'omakase', 'away', 'off'];

export const INTENT_LABELS: Record<Intent, string> = {
  delivery: '宅配',
  sales: '営業',
  service: '点検',
  acquaintance: '知人',
  emergency: '緊急',
  unknown: '不明',
};

const OUTCOME_LABELS: Record<Exclude<Outcome, 'none'>, string> = {
  leave_at_door: '置き配を頼み、了承された',
  delivery_slip: '不在票を入れるよう頼んだ',
  declined: '断った',
  callback: '改めて連絡するよう頼んだ',
  escalated: '担当者に連絡すると伝えた',
};

const END_REASON_LABELS: Record<EndReason, string> = {
  closing: 'AI があいさつで会話を締めた',
  silence: '訪問者が話さなくなった',
  time_limit: '通話の上限時間になった',
  fallback: 'サーバーにつながらなかった',
  safe: '異常が起きて終えた',
  mode_off: '停止モードだった',
  resident: 'スタッフが対応した',
  no_answer: '応答しなかった',
};

export const SPEAKER_LABELS: Record<Speaker, string> = {
  visitor: '訪問者',
  ai: 'AI',
  canned: '定型音声',
};

export function intentLabel(visit: Pick<Visit, 'intent'>): string {
  return INTENT_LABELS[visit.intent ?? 'unknown'];
}

// 見出しには会社名を、なければ意図を出す
export function visitTitle(visit: Pick<Visit, 'intent' | 'company'>): string {
  return visit.company ?? intentLabel(visit);
}

export function outcomeLabel(visit: Pick<Visit, 'outcome' | 'end_reason' | 'status'>): string {
  if (visit.status === 'ringing') return '呼び出し中';
  if (visit.status === 'in_call') return '通話中';
  if (visit.outcome && visit.outcome !== 'none') return OUTCOME_LABELS[visit.outcome];
  if (visit.end_reason === 'fallback') return '定型音声で応答した';
  return '用件を聞いた';
}

export function endReasonLabel(reason: EndReason | null): string {
  return reason ? END_REASON_LABELS[reason] : '—';
}

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  nail_salon: 'ネイルサロン',
  massage: 'マッサージ店',
  cram_school: '学習塾',
  other: 'その他',
};

export const BUSINESS_TYPE_ORDER: BusinessType[] = ['nail_salon', 'massage', 'cram_school', 'other'];

export const TONE_LABELS: Record<Tone, string> = {
  very_polite: 'とても丁寧',
  polite: '丁寧',
  friendly: '親しみやすい',
};

export const TONE_ORDER: Tone[] = ['very_polite', 'polite', 'friendly'];

export const WALK_IN_LABELS: Record<WalkInPolicy, string> = {
  take_reservation: '仮予約を受ける',
  notify_shop: '店に連絡する',
  decline: 'お断りする',
};

export const WALK_IN_ORDER: WalkInPolicy[] = ['take_reservation', 'notify_shop', 'decline'];

export const PROVIDER_LABELS: Record<ReservationProvider, string> = {
  monban: 'MONBAN の予約帳',
  google_calendar: 'Google カレンダー',
  square: 'Square 予約',
  hotpepper: 'ホットペッパービューティー',
};

export const PROVIDER_ORDER: ReservationProvider[] = ['monban', 'google_calendar', 'square', 'hotpepper'];

export const SOURCE_LABELS: Record<ReservationSource, string> = {
  app: '手入力',
  ai: 'AI（インターホン）',
  external: 'Google カレンダー',
};

// 外部の予約は、今の予約先の名前を出す
export function sourceLabel(source: ReservationSource, provider: ReservationProvider | null): string {
  return source === 'external' && provider === 'square' ? PROVIDER_LABELS.square : SOURCE_LABELS[source];
}

// API のない予約先には、店が手で入力してから承認してもらう
export function approveDialogTitle(provider: ReservationProvider | null): string {
  if (provider === 'hotpepper') return 'SALON BOARD に\n入力しましたか';
  if (provider === 'square') return 'Square に\n入力しましたか';
  return 'この予約を確定しますか';
}

// 予約の札。確定は札を出さない
export function reservationBadge(reservation: Pick<Reservation, 'status' | 'arrived_at'>): string | null {
  if (reservation.status === 'cancelled') return 'キャンセル';
  if (reservation.arrived_at) return '到着済み';
  if (reservation.status === 'pending') return '仮予約';
  return null;
}

export function reservationStatusLabel(reservation: Pick<Reservation, 'status' | 'arrived_at'>): string {
  return reservationBadge(reservation) ?? '確定';
}

const NOTIFICATION_CATEGORY_LABELS: Record<string, string> = {
  visit: '来客',
  reservation: '予約',
  system: '異常',
};

export function notificationCategoryLabel(category: string): string {
  return NOTIFICATION_CATEGORY_LABELS[category] ?? 'その他';
}
