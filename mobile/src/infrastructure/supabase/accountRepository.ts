// アカウントの削除（Edge Function「account」）
import type { AccountRepository } from '../../repositories';
import { callFunction } from './functions';

export const supabaseAccountRepository: AccountRepository = {
  async remove() {
    await callFunction('account', 'DELETE');
  },
};
