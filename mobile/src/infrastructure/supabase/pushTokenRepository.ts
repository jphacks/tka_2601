import type { PushTokenRepository } from '../../repositories';
import { requireSupabase } from './client';

export const supabasePushTokenRepository: PushTokenRepository = {
  async save(userId, token) {
    const { error } = await requireSupabase()
      .from('push_tokens')
      .upsert({ user_id: userId, token, platform: 'ios', last_seen_at: new Date().toISOString() });
    if (error) throw error;
  },
  async remove(userId, token) {
    const { error } = await requireSupabase().from('push_tokens').delete().eq('user_id', userId).eq('token', token);
    if (error) throw error;
  },
};
