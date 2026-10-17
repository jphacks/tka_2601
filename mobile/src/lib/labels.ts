import type { EndReason, Intent, Mode, Outcome, Speaker, Visit } from './types';

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
  escalated: '家の者に連絡すると伝えた',
};

const END_REASON_LABELS: Record<EndReason, string> = {
  closing: 'AI があいさつで会話を締めた',
  silence: '訪問者が話さなくなった',
  time_limit: '通話の上限時間になった',
  fallback: 'サーバーにつながらなかった',
  safe: '異常が起きて終えた',
  mode_off: '停止モードだった',
  resident: '住人が対応した',
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
