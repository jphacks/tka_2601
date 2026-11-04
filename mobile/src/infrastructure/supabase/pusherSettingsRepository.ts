import { PusherSettingsChanged, readPusherConfig, readPusherSettings } from '../../domain/pusher';
import type { PusherSettingsRepository } from '../../repositories';
import { requireSupabase } from './client';

const COLUMNS = 'desired_revision, desired_config, applied_revision, applied_config, applied_at, reported_at, apply_error, runtime_status, capabilities';

export const supabasePusherSettingsRepository: PusherSettingsRepository = {
  async get(deviceId) {
    const { data, error } = await requireSupabase()
      .from('device_pusher_settings')
      .select(COLUMNS)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (error) throw error;
    return data ? readPusherSettings(data) : null;
  },
  async save(deviceId, expectedRevision, config) {
    const { data, error } = await requireSupabase().rpc('save_pusher_settings', {
      p_device_id: deviceId,
      p_expected_revision: expectedRevision,
      p_config: readPusherConfig(config),
    });
    if (error?.code === 'PT409') throw new PusherSettingsChanged();
    if (error) throw error;
    return readPusherSettings(data);
  },
};
