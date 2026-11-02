// 自然言語の入力の案（docs/reservations.md 8章）。案は読み取った結果で、確認するまで何も書き込まない
export type TimeSpan = { starts_at: string; ends_at: string };
export type DayHours = { closed: boolean; open: string; close: string };

export type AddReservationProposal = TimeSpan & {
  type: 'add_reservation';
  customer_name: string;
  customer_phone: string | null;
  service_name: string | null;
  note: string | null;
  warnings: string[];
};

export type UpdateReservationProposal = {
  type: 'update_reservation';
  reservation_id: string;
  customer_name: string;
  service_name: string | null;
  before: TimeSpan;
  after: TimeSpan;
  warnings: string[];
};

export type SetBusinessHoursProposal = {
  type: 'set_business_hours';
  // 日曜が 0
  day: number;
  before: DayHours;
  after: DayHours;
  warnings: string[];
};

export type UnknownProposal = { type: 'unknown'; reason: string; warnings: string[] };

export type AssistantProposal =
  | AddReservationProposal
  | UpdateReservationProposal
  | SetBusinessHoursProposal
  | UnknownProposal;
