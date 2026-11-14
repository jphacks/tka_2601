export type NotificationKind = {
  kind: string;
  label: string;
  category: string;
  default_enabled: boolean;
  sort_order: number;
};

export type NotificationPreference = { kind: string; enabled: boolean };

export type AppNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
};

export const NOTIFICATIONS_PAGE_SIZE = 50;

export type NotificationTarget = { type: 'reservation' | 'visit' | 'provider'; id: string };

// 通知の data から開く画面を決める。予約を先に見る（到着の通知は来客にも結び付くため）。
// 予約先との接続エラーは予約先の設定を開く
export function notificationTarget(data: Record<string, unknown>, kind?: string): NotificationTarget | null {
  if (typeof data.reservation_id === 'string') return { type: 'reservation', id: data.reservation_id };
  if (typeof data.visit_id === 'string') return { type: 'visit', id: data.visit_id };
  if (kind === 'calendar_sync_failed') return { type: 'provider', id: '' };
  return null;
}

export function isUnread(createdAt: string, readThrough: string | null): boolean {
  if (!readThrough) return true;
  return new Date(createdAt).getTime() > new Date(readThrough).getTime();
}

// 通知の時刻には差があるので、読んだ位置は届いている中で最も新しい通知の時刻にする
export function newestCreatedAt(rows: readonly { created_at: string }[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (!newest || new Date(row.created_at).getTime() > new Date(newest).getTime()) newest = row.created_at;
  }
  return newest;
}

export type NotificationKindSection = {
  category: string;
  kinds: (NotificationKind & { enabled: boolean })[];
};

// 種類を表の並びのままカテゴリごとにまとめ、自分の設定を重ねる。設定がなければ種類の既定値
export function groupNotificationKinds(
  kinds: readonly NotificationKind[],
  preferences: readonly NotificationPreference[],
): NotificationKindSection[] {
  const enabled = new Map(preferences.map((p) => [p.kind, p.enabled]));
  const sections: NotificationKindSection[] = [];
  for (const kind of kinds) {
    const row = { ...kind, enabled: enabled.get(kind.kind) ?? kind.default_enabled };
    const section = sections.find((s) => s.category === kind.category);
    if (section) section.kinds.push(row);
    else sections.push({ category: kind.category, kinds: [row] });
  }
  return sections;
}
