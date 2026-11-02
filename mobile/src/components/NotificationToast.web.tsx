import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type AppNotification, notificationTarget } from '../domain/notification';
import { useAuth } from '../lib/auth';
import { useBadges } from '../lib/badges';
import { repositories } from '../lib/container';
import { colors, radius } from '../theme';

// Web にはプッシュ通知がないので、開いているあいだは一定の間隔で新しい通知を読み、画面の隅に出す
const POLL_MS = 30_000;
const SHOW_MS = 10_000;

export function NotificationToast() {
  const { session, household } = useAuth();
  const { refresh } = useBadges();
  const userId = session?.user.id ?? null;
  const householdId = household?.id ?? null;
  const [toast, setToast] = useState<AppNotification | null>(null);
  // これより新しい通知だけを出す。最初に読んだ時点を境にする
  const seenThrough = useRef<number | null>(null);
  const muted = useRef<Set<string>>(new Set());

  const check = useCallback(async () => {
    if (!userId || !householdId) return;
    try {
      refresh();
      const rows = await repositories.notifications.list(householdId);
      const newest = rows.reduce((max, row) => Math.max(max, new Date(row.created_at).getTime()), 0);
      if (seenThrough.current === null) {
        seenThrough.current = newest;
        return;
      }
      const boundary = seenThrough.current;
      seenThrough.current = Math.max(boundary, newest);
      // 自分の操作で作られた通知と、自分が切っている種類は出さない
      const fresh = rows.find(
        (row) =>
          new Date(row.created_at).getTime() > boundary &&
          row.actor_user_id !== userId &&
          !muted.current.has(row.kind),
      );
      if (fresh) setToast(fresh);
    } catch {
      // 次の間隔で読み直す
    }
  }, [householdId, refresh, userId]);

  useEffect(() => {
    if (!userId || !householdId) return;
    let cancelled = false;
    Promise.all([repositories.notifications.listKinds(), repositories.notifications.listPreferences(userId)])
      .then(([kinds, preferences]) => {
        if (cancelled) return;
        const enabled = new Map(preferences.map((p) => [p.kind, p.enabled]));
        muted.current = new Set(kinds.filter((k) => !(enabled.get(k.kind) ?? k.default_enabled)).map((k) => k.kind));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) check();
      });
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check, householdId, userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  function open(notification: AppNotification) {
    setToast(null);
    const target = notificationTarget(notification.data, notification.kind);
    if (target?.type === 'reservation') router.push({ pathname: '/reservations/[id]', params: { id: target.id } });
    else if (target?.type === 'visit') router.push({ pathname: '/visits/[id]', params: { id: target.id } });
    else if (target?.type === 'provider') router.push('/settings/provider');
    else router.push('/notifications');
  }

  return (
    <View style={styles.host} pointerEvents="box-none" accessibilityLiveRegion="polite">
      <View style={styles.toast}>
        <Pressable onPress={() => open(toast)} accessibilityRole="button" style={styles.body}>
          <Text style={styles.title} numberOfLines={1}>
            {toast.title}
          </Text>
          {toast.body ? (
            <Text style={styles.text} numberOfLines={2}>
              {toast.body}
            </Text>
          ) : null}
        </Pressable>
        <Pressable onPress={() => setToast(null)} accessibilityRole="button" accessibilityLabel="閉じる" style={styles.close}>
          <Text style={styles.closeText}>閉じる</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', top: 16, right: 16, left: 16, alignItems: 'flex-end', zIndex: 10 },
  toast: {
    width: '100%',
    maxWidth: 360,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  body: { flex: 1, minWidth: 0, paddingVertical: 12, paddingLeft: 16, gap: 2 },
  title: { fontSize: 15, fontWeight: '700', color: colors.text },
  text: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  close: { paddingHorizontal: 14, alignSelf: 'stretch', justifyContent: 'center' },
  closeText: { fontSize: 13, color: colors.navy },
});
