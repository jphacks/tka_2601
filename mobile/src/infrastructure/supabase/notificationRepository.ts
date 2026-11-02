import { type NotificationKind, type NotificationPreference, NOTIFICATIONS_PAGE_SIZE } from '../../domain/notification';
import type { NotificationRepository } from '../../repositories';
import { requireSupabase } from './client';
import { toNotification } from './mappers';

export const supabaseNotificationRepository: NotificationRepository = {
  async list(householdId, page) {
    const from = page * NOTIFICATIONS_PAGE_SIZE;
    const { data, error } = await requireSupabase()
      .from('notifications')
      .select('id, kind, title, body, data, actor_user_id, created_at')
      .eq('household_id', householdId)
      .order('created_at', { ascending: false })
      .range(from, from + NOTIFICATIONS_PAGE_SIZE - 1);
    if (error) throw error;
    return (data ?? []).map(toNotification);
  },
  async getReadThrough(userId) {
    const { data, error } = await requireSupabase()
      .from('notification_read_states')
      .select('read_through')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return (data as { read_through: string } | null)?.read_through ?? null;
  },
  async saveReadThrough(userId, readThrough) {
    const { error } = await requireSupabase()
      .from('notification_read_states')
      .upsert({ user_id: userId, read_through: readThrough });
    if (error) throw error;
  },
  // 未読の数。自分の操作で作られた通知は数えない
  async countUnread(householdId, userId, readThrough) {
    let query = requireSupabase()
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('household_id', householdId)
      .or(`actor_user_id.is.null,actor_user_id.neq.${userId}`);
    if (readThrough) query = query.gt('created_at', readThrough);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  },
  async listKinds() {
    const { data, error } = await requireSupabase()
      .from('notification_kinds')
      .select('kind, label, category, default_enabled, sort_order')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return (data ?? []) as NotificationKind[];
  },
  async listPreferences(userId) {
    const { data, error } = await requireSupabase()
      .from('notification_preferences')
      .select('kind, enabled')
      .eq('user_id', userId);
    if (error) throw error;
    return (data ?? []) as NotificationPreference[];
  },
  async savePreference(userId, kind, enabled) {
    const { error } = await requireSupabase()
      .from('notification_preferences')
      .upsert({ user_id: userId, kind, enabled, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
};
