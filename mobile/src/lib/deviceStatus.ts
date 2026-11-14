import type { Device } from '../domain/device';
import type { Mode } from '../domain/visit';

// 最後の通信からこの時間を過ぎたら、本体との通信が途切れたとみなす
export const STALE_AFTER_MS = 15 * 60_000;

// 反映待ちの間に本体情報を取り直す回数の上限。約3分で諦め、画面を開き直せばまた始める
export const PENDING_REFRESH_LIMIT = 20;

// 反映待ちの間に本体情報を取り直す間隔。本体は15秒ごとにモードを取りに来て、
// 適用したらすぐ報告する。最初の1分は5秒ごと、その後は15秒ごとに取り直す
export function pendingRefreshDelay(attempt: number): number {
  return attempt < 12 ? 5_000 : 15_000;
}

export type DeviceStatusRow = {
  // 本体が報告した適用中のモード。報告がなければ null（画面では 未報告 と出す）
  applied: Mode | null;
  // 保存したモードと適用中のモードが食い違うとき true
  pending: boolean;
  // 最終通信 3分前。一度も届いていなければ 通信なし
  communication: string;
  // 最後の通信から 15 分を過ぎたとき true
  stale: boolean;
};

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

// たった今、3分前、2時間前、4日前。時計のずれで未来になったときは たった今
export function relativeAgo(value: string, now: Date): string {
  const time = timestamp(value);
  if (time === null) return value;
  const minutes = Math.floor(Math.max(now.getTime() - time, 0) / 60_000);
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

// 動作モードの下に出す、本体の状態の行。一度も報告がなければ null（行を出さない）
export function deviceStatusRow(
  device: Pick<Device, 'mode' | 'applied_mode' | 'last_heartbeat_at'>,
  now: Date,
): DeviceStatusRow | null {
  const heartbeat = timestamp(device.last_heartbeat_at);
  if (device.applied_mode === null && heartbeat === null) return null;
  return {
    applied: device.applied_mode,
    pending: device.applied_mode !== null && device.applied_mode !== device.mode,
    communication:
      heartbeat === null ? '通信なし' : `最終通信 ${relativeAgo(device.last_heartbeat_at as string, now)}`,
    stale: heartbeat !== null && now.getTime() - heartbeat > STALE_AFTER_MS,
  };
}
