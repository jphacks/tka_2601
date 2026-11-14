import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

// mobile/.env に入れる（.env.example を参照）。publishable key だけを使い、secret key はアプリに置かない
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const MISSING_CONFIG_MESSAGE =
  'Supabase の設定がありません。mobile/.env に EXPO_PUBLIC_SUPABASE_URL と EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY を入れて、アプリを起動し直してください。';

export const supabase: SupabaseClient | null =
  url && publishableKey
    ? createClient(url, publishableKey, {
        auth: {
          storage: AsyncStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
          flowType: 'pkce',
        },
      })
    : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error(MISSING_CONFIG_MESSAGE);
  return supabase;
}

// アプリが前面にいるあいだだけトークンを自動で更新する
if (supabase) {
  const client = supabase;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') client.auth.startAutoRefresh();
    else client.auth.stopAutoRefresh();
  });
}
