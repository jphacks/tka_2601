import type { Household, InvitePreview, Member } from '../../domain/group';
import type { GroupRepository } from '../../repositories';
import { requireSupabase } from './client';

export const supabaseGroupRepository: GroupRepository = {
  async getMembership(userId) {
    const { data, error } = await requireSupabase()
      .from('household_members')
      .select('household_id, households(id, name)')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const household = data.households as unknown as Household | null;
    return household ? { household } : null;
  },
  async create(name) {
    const { data, error } = await requireSupabase().rpc('create_household', { name });
    if (error) throw error;
    return data as string;
  },
  async getInvitePreview(token) {
    const { data, error } = await requireSupabase().rpc('get_household_invite', { token });
    if (error) throw error;
    const rows = (data ?? []) as InvitePreview[];
    return rows[0] ?? null;
  },
  async acceptInvite(token) {
    const { data, error } = await requireSupabase().rpc('accept_household_invite', { token });
    if (error) throw error;
    return data as string;
  },
  async getOrCreateInviteToken() {
    const { data, error } = await requireSupabase().rpc('get_or_create_household_invite');
    if (error) throw error;
    return data as string;
  },
  async listMembers() {
    const { data, error } = await requireSupabase().rpc('household_member_profiles');
    if (error) throw error;
    return (data ?? []) as Member[];
  },
};
