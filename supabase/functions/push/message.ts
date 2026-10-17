// 通知の文面を組み立てる。来客時（visits の作成）と対応後（終話への更新）の2種類

export type Visit = {
  id: string;
  household_id: string;
  mode: "normal" | "omakase" | "away" | "off";
  chimed_at: string;
  status: "ringing" | "in_call" | "ended" | "missed";
  intent: "delivery" | "sales" | "service" | "emergency" | "acquaintance" | "unknown" | null;
  company: string | null;
  outcome:
    | "leave_at_door"
    | "delivery_slip"
    | "declined"
    | "callback"
    | "escalated"
    | "none"
    | null;
};

export type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Visit;
  old_record: Visit | null;
};

export type Notice = {
  kind: "chime" | "ended";
  title: string;
  body: string;
};

const MODE_LABELS: Record<Visit["mode"], string> = {
  normal: "通常",
  omakase: "おまかせ",
  away: "外出",
  off: "停止",
};

const INTENT_LABELS: Record<NonNullable<Visit["intent"]>, string> = {
  delivery: "宅配",
  sales: "営業・勧誘",
  service: "点検・工事",
  emergency: "緊急の用件",
  acquaintance: "知人",
  unknown: "来客",
};

const OUTCOME_TEXTS: Record<NonNullable<Visit["outcome"]>, string> = {
  leave_at_door: "置き配をお願いしました",
  delivery_slip: "不在票をお願いしました",
  declined: "お断りしました",
  callback: "改めて連絡するようお願いしました",
  escalated: "家の者に連絡すると伝えました",
  none: "特に対応はしていません",
};

const EXCERPT_LENGTH = 40;

const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
});

// 送る通知の種類を決める。送らないときは null。
// 終話済みの来客が初めて届いたとき（回線断からの回復）は、対応後の通知だけを送る
export function noticeKind(payload: WebhookPayload): Notice["kind"] | null {
  if (payload.table !== "visits") return null;
  if (payload.type === "INSERT") return payload.record.status === "ended" ? "ended" : "chime";
  if (
    payload.type === "UPDATE" &&
    payload.record.status === "ended" &&
    payload.old_record?.status !== "ended"
  ) {
    return "ended";
  }
  return null;
}

export function chimeNotice(visit: Visit): Notice {
  const time = timeFormat.format(new Date(visit.chimed_at));
  return {
    kind: "chime",
    title: "来客があります",
    body: `${time} にチャイムが鳴りました（${MODE_LABELS[visit.mode]}モード）`,
  };
}

// firstVisitorText は訪問者の最初の発話。先頭 40 字を抜粋として載せる
export function endedNotice(visit: Visit, firstVisitorText: string | null): Notice {
  const label = INTENT_LABELS[visit.intent ?? "unknown"];
  const title = visit.company ? `${label}（${visit.company}）` : label;

  let outcome = visit.outcome ? OUTCOME_TEXTS[visit.outcome] : "対応は記録されていません";
  if (visit.outcome === "delivery_slip" && visit.mode === "away") {
    outcome += "。再配達の手配をしてください";
  }

  const lines = [outcome];
  if (firstVisitorText) lines.push(`「${excerpt(firstVisitorText)}」`);
  return { kind: "ended", title, body: lines.join("\n") };
}

function excerpt(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length > EXCERPT_LENGTH ? `${chars.slice(0, EXCERPT_LENGTH).join("")}…` : chars.join("");
}
