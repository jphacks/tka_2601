// 自然言語の入力から作る変更の案（docs/reservations.md 8章）。
// 案は書き込まない。店の人が確認カードで承認してから、アプリが既存の API で書き込む
const MAX_NAME = 60;
const MAX_PHONE = 30;
const MAX_SERVICE = 40;
const MAX_NOTE = 500;

export type DayHours = { closed: boolean; open: string | null; close: string | null };

export type AddReservationProposal = {
  type: "add_reservation";
  customer_name: string;
  customer_phone: string | null;
  service_name: string | null;
  starts_at: string;
  ends_at: string;
  note: string | null;
  warnings: string[];
};

export type UpdateReservationProposal = {
  type: "update_reservation";
  reservation_id: string;
  customer_name: string;
  service_name: string | null;
  before: { starts_at: string; ends_at: string };
  after: { starts_at: string; ends_at: string };
  warnings: string[];
};

export type SetBusinessHoursProposal = {
  type: "set_business_hours";
  // 日曜が 0
  day: number;
  before: DayHours;
  after: DayHours;
  warnings: string[];
};

export type UnknownProposal = {
  type: "unknown";
  reason: string;
  warnings: string[];
};

export type AssistantProposal =
  | AddReservationProposal
  | UpdateReservationProposal
  | SetBusinessHoursProposal
  | UnknownProposal;

export function unknownProposal(reason: string): UnknownProposal {
  return { type: "unknown", reason, warnings: [] };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function withinLength(text: string, max: number): boolean {
  return Array.from(text).length <= max;
}

// 敬称を外した名前。読めなければ null
export function cleanName(value: unknown): string | null {
  const name = trimmed(value).replace(/\s*(様|さま|さん|ちゃん|くん)$/, "").trim();
  return name !== "" && withinLength(name, MAX_NAME) ? name : null;
}

export function cleanPhone(value: unknown): string | null {
  const phone = trimmed(value);
  return /^[0-9+()\-\s]{3,}$/.test(phone) && withinLength(phone, MAX_PHONE) ? phone : null;
}

export function cleanService(value: unknown): string | null {
  const service = trimmed(value);
  return service !== "" && withinLength(service, MAX_SERVICE) ? service : null;
}

export function cleanNote(value: unknown): string | null {
  const note = trimmed(value);
  return note !== "" && withinLength(note, MAX_NOTE) ? note : null;
}
