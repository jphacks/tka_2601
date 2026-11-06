import { normalizePairingCode } from '../../domain/devicePairing';
import type { DeviceRepository } from '../../repositories';
import { requireSupabase } from './client';
import { deviceRequest } from './deviceRequest';
import { toDevice } from './mappers';

export const supabaseDeviceRepository: DeviceRepository = {
  // グループの本体。1つのグループに本体は1台の前提
  async get(householdId) {
    const { data, error } = await deviceRequest((signal) => requireSupabase()
      .from('devices')
      .select('id, household_id, name, mode, applied_mode, applied_mode_at, last_heartbeat_at, away_leave_at_door, auto_away, extra_instructions')
      .eq('household_id', householdId)
      .order('created_at', { ascending: true })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle());
    if (error) throw error;
    return data ? toDevice(data) : null;
  },
  async claim(code) {
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error('8文字のペアリングコードを入力してください。');
    const { data, error } = await deviceRequest((signal) => requireSupabase()
      .rpc('claim_device', { code: normalized }).abortSignal(signal));
    if (error) throw error;
    if (typeof data !== 'string' || !data) throw new Error('登録結果を確認できませんでした。設定から本体を確認してください。');
    return data;
  },
  async update(id, patch) {
    const { error } = await requireSupabase().from('devices').update(patch).eq('id', id);
    if (error) throw error;
  },
};
