import type { ShopService } from '../../domain/shop';
import type { ShopRepository } from '../../repositories';
import { requireSupabase } from './client';
import { toShopProfile } from './mappers';

export const supabaseShopRepository: ShopRepository = {
  async getProfile(householdId) {
    const { data, error } = await requireSupabase()
      .from('shop_profiles')
      .select('household_id, business_type, tone, greeting, business_hours, walk_in_policy, reservation_provider')
      .eq('household_id', householdId)
      .maybeSingle();
    if (error) throw error;
    return data ? toShopProfile(data) : null;
  },
  async updateProfile(householdId, patch) {
    const { error } = await requireSupabase().from('shop_profiles').update(patch).eq('household_id', householdId);
    if (error) throw error;
  },
  async rename(householdId, name) {
    const { error } = await requireSupabase().from('households').update({ name }).eq('id', householdId);
    if (error) throw error;
  },
  async listServices(householdId) {
    const { data, error } = await requireSupabase()
      .from('shop_services')
      .select('id, household_id, name, duration_minutes, price_yen, sort_order')
      .eq('household_id', householdId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ShopService[];
  },
  async createService(householdId, input, sortOrder) {
    const { error } = await requireSupabase()
      .from('shop_services')
      .insert({ ...input, household_id: householdId, sort_order: sortOrder });
    if (error) throw error;
  },
  async updateService(id, input) {
    const { error } = await requireSupabase().from('shop_services').update(input).eq('id', id);
    if (error) throw error;
  },
  async removeService(id) {
    const { error } = await requireSupabase().from('shop_services').delete().eq('id', id);
    if (error) throw error;
  },
};
