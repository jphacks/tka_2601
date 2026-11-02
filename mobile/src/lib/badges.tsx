import * as Notifications from 'expo-notifications';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { addDays, PENDING_RANGE_DAYS, startOfDayDate } from '../domain/reservation';
import { useAuth } from './auth';
import { repositories } from './container';

type Badges = {
  unread: number;
  pending: number;
  refresh: () => void;
};

const BadgeContext = createContext<Badges | null>(null);

// タブの数字。読めないときは前の値のままにする。グループに入る前は何も読まない
export function BadgeProvider({ children }: { children: ReactNode }) {
  const { session, household } = useAuth();
  const userId = session?.user.id ?? null;
  const householdId = household?.id ?? null;
  const [unread, setUnread] = useState(0);
  const [pending, setPending] = useState(0);
  // 遅れて届いた古い数で上書きしない
  const request = useRef(0);

  const refresh = useCallback(() => {
    const current = ++request.current;
    if (!userId || !householdId) return;
    repositories.notifications
      .getReadThrough(userId)
      .then((readThrough) => repositories.notifications.countUnread(householdId, userId, readThrough))
      .then((count) => {
        if (current === request.current) setUnread(count);
      })
      .catch(() => undefined);
    const today = startOfDayDate(new Date());
    repositories.reservations
      .list({ from: today, to: addDays(today, PENDING_RANGE_DAYS) }, 'pending')
      .then(({ reservations }) => {
        if (current === request.current) setPending(reservations.length);
      })
      .catch(() => undefined);
  }, [householdId, userId]);

  // 別の人に変わったら、前の人の数を残さない
  useEffect(() => {
    setUnread(0);
    setPending(0);
  }, [userId]);

  useEffect(() => {
    refresh();
    const received = Notifications.addNotificationReceivedListener(() => refresh());
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      received.remove();
      appState.remove();
    };
  }, [refresh]);

  const value = useMemo(() => ({ unread, pending, refresh }), [unread, pending, refresh]);
  return <BadgeContext.Provider value={value}>{children}</BadgeContext.Provider>;
}

export function useBadges(): Badges {
  const value = useContext(BadgeContext);
  if (!value) throw new Error('useBadges は BadgeProvider の内側で使う');
  return value;
}
