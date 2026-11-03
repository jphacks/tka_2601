import type { Device } from '../../domain/device';
import type { DeviceRepository } from '../../repositories';
import { requireSupabase } from './client';

export const supabaseDeviceRepository: DeviceRepository = {
  // グループの本体。1つのグループに本体は1台の前提
  async get(householdId) {
    const { data, error } = await requireSupabase()
      .from('devices')
      .select('id, household_id, name, mode, away_leave_at_door, auto_away, extra_instructions')
      .eq('household_id', householdId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as Device | null) ?? null;
  },
  async update(id, patch) {
    const { error } = await requireSupabase().from('devices').update(patch).eq('id', id);
    if (error) throw error;
  },
};
