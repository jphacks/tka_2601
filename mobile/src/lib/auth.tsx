import type { Session } from '@supabase/supabase-js';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { Household } from '../domain/group';
import { repositories } from './container';
import { supabase } from '../infrastructure/supabase/client';

type AuthContextValue = {
  // セッションと所属グループを読み終えたか
  ready: boolean;
  session: Session | null;
  household: Household | null;
  // 所属を読めなかった。「所属なし」とは別で、お店の作成へ移さない
  membershipFailed: boolean;
  refreshMembership: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessionLoaded, setSessionLoaded] = useState(!supabase);
  const [session, setSession] = useState<Session | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [membershipUserId, setMembershipUserId] = useState<string | null>(null);
  const [membershipFailed, setMembershipFailed] = useState(false);
  // 所属を読めた相手。別の人の所属を失敗のときに残さないため
  const loadedUserId = useRef<string | null>(null);

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
      const membership = await repositories.groups.getMembership(userId);
      setHousehold(membership?.household ?? null);
      setMembershipFailed(false);
      loadedUserId.current = userId;
    } catch {
      // 読めていた所属は保つ。一度も読めていなければ、再試行の画面を出す
      if (loadedUserId.current !== userId) {
        setHousehold(null);
        setMembershipFailed(true);
      }
    } finally {
      setMembershipUserId(userId);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setHousehold(null);
      setMembershipUserId(null);
      setMembershipFailed(false);
      loadedUserId.current = null;
      return;
    }
    refreshMembership();
  }, [userId, refreshMembership]);

  const ready = sessionLoaded && (!userId || membershipUserId === userId);

  const value = useMemo<AuthContextValue>(
    () => ({ ready, session, household, membershipFailed, refreshMembership }),
    [ready, session, household, membershipFailed, refreshMembership],
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
