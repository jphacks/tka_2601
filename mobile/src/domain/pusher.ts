export type PusherId = 'p1' | 'p2';

export type PusherConfig = {
  schema_version: 1;
  enabled_pushers: PusherId[];
  assignments: { call_start: PusherId; call_end: PusherId };
};

export type PusherSettings = {
  desired_revision: number;
  desired_config: PusherConfig | null;
  applied_revision: number | null;
  applied_config: PusherConfig | null;
  applied_at: string | null;
  reported_at: string | null;
  apply_error: string | null;
  runtime_status: string | null;
  capabilities: unknown | null;
};

export type PusherCapabilities = {
  schema_versions: number[];
  pushers: { id: PusherId; gpio: number }[];
};

export class PusherSettingsChanged extends Error {
  constructor() {
    super('別のメンバーが設定を変更しました。最新の設定を読み直してください。');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pusherId(value: unknown): value is PusherId {
  return value === 'p1' || value === 'p2';
}

export function readPusherConfig(value: unknown): PusherConfig {
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.enabled_pushers) ||
      !record(value.assignments) || !pusherId(value.assignments.call_start) || !pusherId(value.assignments.call_end)) {
    throw new Error('プッシャー設定の形式を読み取れませんでした。');
  }
  const enabled = value.enabled_pushers;
  const { call_start, call_end } = value.assignments;
  if ((enabled.length !== 1 && enabled.length !== 2) || !enabled.every(pusherId) ||
      new Set(enabled).size !== enabled.length || !enabled.includes(call_start) || !enabled.includes(call_end) ||
      (enabled.length === 1 ? call_start !== call_end : call_start === call_end)) {
    throw new Error('使用する個数と機能の割り当てが一致しません。');
  }
  return { schema_version: 1, enabled_pushers: [...enabled].sort(), assignments: { call_start, call_end } };
}

export function pusherConfig(count: 1 | 2, start: PusherId): PusherConfig {
  return {
    schema_version: 1,
    enabled_pushers: count === 1 ? [start] : ['p1', 'p2'],
    assignments: { call_start: start, call_end: count === 1 ? start : start === 'p1' ? 'p2' : 'p1' },
  };
}

export function samePusherConfig(a: PusherConfig | null, b: PusherConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.schema_version === b.schema_version && a.enabled_pushers.length === b.enabled_pushers.length &&
    a.enabled_pushers.every((id) => b.enabled_pushers.includes(id)) &&
    a.assignments.call_start === b.assignments.call_start && a.assignments.call_end === b.assignments.call_end;
}

export function pusherCapabilities(value: unknown): PusherCapabilities | null {
  if (!record(value) || !Array.isArray(value.schema_versions) || !value.schema_versions.every(Number.isInteger) ||
      !Array.isArray(value.pushers) || !value.pushers.every((p) => record(p) && pusherId(p.id) && Number.isInteger(p.gpio))) {
    return null;
  }
  return value as PusherCapabilities;
}

export function readPusherSettings(value: unknown): PusherSettings {
  if (!record(value) || !Number.isInteger(value.desired_revision) || (value.desired_revision as number) < 0 ||
      (value.applied_revision !== null && (!Number.isInteger(value.applied_revision) || (value.applied_revision as number) < 0))) {
    throw new Error('プッシャー設定の反映状況を読み取れませんでした。');
  }
  for (const field of ['applied_at', 'reported_at', 'apply_error', 'runtime_status'] as const) {
    if (value[field] !== null && typeof value[field] !== 'string') {
      throw new Error('プッシャー設定の反映状況を読み取れませんでした。');
    }
  }
  return {
    desired_revision: value.desired_revision as number,
    desired_config: value.desired_config === null ? null : readPusherConfig(value.desired_config),
    applied_revision: value.applied_revision as number | null,
    applied_config: value.applied_config === null ? null : readPusherConfig(value.applied_config),
    applied_at: value.applied_at as string | null,
    reported_at: value.reported_at as string | null,
    apply_error: value.apply_error as string | null,
    runtime_status: value.runtime_status as string | null,
    capabilities: value.capabilities ?? null,
  };
}

export type PusherSyncState = 'unknown' | 'unsupported' | 'pending' | 'applied' | 'failed' | 'manual_check_required' | 'local';

export function pusherSyncState(settings: PusherSettings | null): PusherSyncState {
  if (!settings) return 'unknown';
  if (settings.runtime_status === 'manual_check_required') return 'manual_check_required';
  const capability = pusherCapabilities(settings.capabilities);
  if (capability && !capability.schema_versions.includes(1)) return 'unsupported';
  if (settings.apply_error && settings.apply_error !== 'busy') return 'failed';
  if (!settings.desired_config) return capability && settings.applied_config ? 'local' : 'unknown';
  if (settings.applied_revision === settings.desired_revision &&
      samePusherConfig(settings.applied_config, settings.desired_config) && settings.applied_at) return 'applied';
  return 'pending';
}

export const PUSHER_SYNC_LABELS: Record<PusherSyncState, string> = {
  unknown: '本体を確認できません',
  unsupported: '本体の更新が必要です',
  pending: '本体への反映待ち',
  applied: '本体に反映済み',
  failed: '本体に反映できませんでした',
  manual_check_required: '親機の状態を確認してください',
  local: '本体に保存された設定を使用中',
};
