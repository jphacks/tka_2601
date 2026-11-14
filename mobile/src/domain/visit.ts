// 来客の記録。値はボイスエージェントが書くので、知らない値は infrastructure の変換で丸める
export type Mode = 'normal' | 'omakase' | 'away' | 'off';
export type VisitStatus = 'ringing' | 'in_call' | 'ended' | 'missed';
export type Intent = 'delivery' | 'sales' | 'service' | 'acquaintance' | 'emergency' | 'unknown';
export type Outcome = 'leave_at_door' | 'delivery_slip' | 'declined' | 'callback' | 'escalated' | 'none';
export type EndReason =
  | 'closing'
  | 'silence'
  | 'time_limit'
  | 'fallback'
  | 'safe'
  | 'mode_off'
  | 'resident'
  | 'no_answer';
export type Speaker = 'visitor' | 'ai' | 'canned';

export type Visit = {
  id: string;
  household_id: string;
  device_id: string;
  mode: Mode;
  chimed_at: string;
  answered_at: string | null;
  ended_at: string | null;
  status: VisitStatus;
  intent: Intent | null;
  company: string | null;
  outcome: Outcome | null;
  end_reason: EndReason | null;
};

export type VisitMessage = {
  visit_id: string;
  seq: number;
  speaker: Speaker;
  text: string;
  spoken_at: string | null;
};

// 一覧の1行。訪問者の最初の発話を添える
export type VisitSummary = Visit & { first_visitor_text: string | null };

export const VISITS_PAGE_SIZE = 50;
