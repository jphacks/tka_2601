import * as Notifications from 'expo-notifications';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

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

  const refresh = useCallback(() => {
    if (!userId || !householdId) return;
    repositories.notifications
      .getReadThrough(userId)
      .then((readThrough) => repositories.notifications.countUnread(householdId, userId, readThrough))
      .then(setUnread)
      .catch(() => undefined);
    const today = startOfDayDate(new Date());
    repositories.reservations
      .list({ from: today, to: addDays(today, PENDING_RANGE_DAYS) }, 'pending')
      .then(({ reservations }) => setPending(reservations.length))
      .catch(() => undefined);
  }, [householdId, userId]);

  useEffect(() => {
    refresh();
    const subscription = Notifications.addNotificationReceivedListener(() => refresh());
    return () => subscription.remove();
  }, [refresh]);

  const value = useMemo(() => ({ unread, pending, refresh }), [unread, pending, refresh]);
  return <BadgeContext.Provider value={value}>{children}</BadgeContext.Provider>;
}

export function useBadges(): Badges {
  const value = useContext(BadgeContext);
  if (!value) throw new Error('useBadges は BadgeProvider の内側で使う');
  return value;
}
