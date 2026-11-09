import type { ChimeEnrollmentRepository } from '../../repositories';
import { requireSupabase } from './client';
import { deviceRequest } from './deviceRequest';
import { toChimeEnrollment } from './mappers';

const COLUMNS = 'request_seq, action, requested_at, handled_seq, phase, reason, registered, reported_at';

export const supabaseChimeEnrollmentRepository: ChimeEnrollmentRepository = {
  async request(deviceId, action) {
    const { data, error } = await deviceRequest((signal) => requireSupabase()
      .rpc('request_chime_enrollment', { p_device_id: deviceId, p_action: action })
      .abortSignal(signal));
    if (error) throw error;
    const seq = typeof data === 'string' ? Number(data) : data;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      throw new Error('チャイム登録の依頼の結果を確認できませんでした。');
    }
    return seq;
  },
  async get(deviceId) {
    const { data, error } = await deviceRequest((signal) => requireSupabase()
      .from('device_chime_enrollment')
      .select(COLUMNS)
      .eq('device_id', deviceId)
      .abortSignal(signal)
      .maybeSingle());
    if (error) throw error;
    return data ? toChimeEnrollment(data) : null;
  },
};
