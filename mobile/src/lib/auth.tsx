import type { Session } from '@supabase/supabase-js';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchMembership } from './api';
import { supabase } from './supabase';
import type { Household } from './types';

type AuthContextValue = {
  // セッションと所属グループを読み終えたか
  ready: boolean;
  session: Session | null;
  household: Household | null;
  refreshMembership: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessionLoaded, setSessionLoaded] = useState(!supabase);
  const [session, setSession] = useState<Session | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [membershipUserId, setMembershipUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoaded(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;

  const refreshMembership = useCallback(async () => {
    if (!userId) return;
    try {
      const membership = await fetchMembership(userId);
      setHousehold(membership?.household ?? null);
    } catch {
      setHousehold(null);
    } finally {
      setMembershipUserId(userId);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setHousehold(null);
      setMembershipUserId(null);
      return;
    }
    refreshMembership();
  }, [userId, refreshMembership]);

  const ready = sessionLoaded && (!userId || membershipUserId === userId);

  const value = useMemo<AuthContextValue>(
    () => ({ ready, session, household, refreshMembership }),
    [ready, session, household, refreshMembership],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth は AuthProvider の内側で使う');
  return value;
}

// グループに入っている画面だけで使う
export function useHousehold(): Household {
  const { household } = useAuth();
  if (!household) throw new Error('グループに入っていない');
  return household;
}
