import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '../../components/Screen';
import { CenterMessage, Separator } from '../../components/ui';
import { appendUnique } from '../../domain/collections';
import {
  type AppNotification,
  isUnread,
  newestCreatedAt,
  notificationTarget,
  NOTIFICATIONS_PAGE_SIZE,
} from '../../domain/notification';
import { useAuth, useHousehold } from '../../lib/auth';
import { useBadges } from '../../lib/badges';
import { useLiveRefresh } from '../../lib/liveRefresh';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { dayKey, hourMinute, sectionTitle } from '../../lib/format';
import { colors, radius } from '../../theme';

type Section = { key: string; title: string; data: AppNotification[] };

function groupByDay(rows: AppNotification[]): Section[] {
  const now = new Date();
  const sections: Section[] = [];
  for (const row of rows) {
    const date = new Date(row.created_at);
    const key = dayKey(date);
    const last = sections[sections.length - 1];
    if (last?.key === key) last.data.push(row);
    else sections.push({ key, title: sectionTitle(date, now), data: [row] });
  }
  return sections;
}

function open(notification: AppNotification) {
  const target = notificationTarget(notification.data, notification.kind);
  if (target?.type === 'reservation') {
    router.push({ pathname: '/reservations/[id]', params: { id: target.id, back: '通知' } });
  } else if (target?.type === 'visit') {
    router.push({ pathname: '/visits/[id]', params: { id: target.id, back: '通知' } });
  } else if (target?.type === 'provider') {
    router.push('/settings/provider');
  }
}

export default function NotificationsScreen() {
  const household = useHousehold();
  const { session } = useAuth();
  const { refresh: refreshBadges } = useBadges();
  const insets = useSafeAreaInsets();
  const userId = session?.user.id ?? null;
  const [rows, setRows] = useState<AppNotification[] | null>(null);
  const [readThrough, setReadThrough] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const page = useRef(0);
  const loadingMore = useRef(false);
  // 読み直しの回数。読み直す前に始めた続きの読み込みの結果を捨てる
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!userId) return;
    const current = ++generation.current;
    try {
      // 未読の印は開いた時点の位置で出し、読んだ位置は先へ進める
      const [previous, first] = await Promise.all([
        repositories.notifications.getReadThrough(userId),
        repositories.notifications.list(household.id, 0),
      ]);
      if (current !== generation.current) return;
      page.current = 0;
      setReadThrough(previous);
      setRows(first);
      setHasMore(first.length === NOTIFICATIONS_PAGE_SIZE);
      setError(null);
      const newest = newestCreatedAt(first);
      if (newest && isUnread(newest, previous)) {
        await repositories.notifications.saveReadThrough(userId, newest);
        refreshBadges();
      }
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, [household.id, userId, refreshBadges]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  useLiveRefresh(load);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function loadMore() {
    if (!hasMore || loadingMore.current || !rows) return;
    loadingMore.current = true;
    const started = generation.current;
    try {
      const next = await repositories.notifications.list(household.id, page.current + 1);
      if (started !== generation.current) return;
      page.current += 1;
      setRows((current) => appendUnique(current ?? [], next));
      setHasMore(next.length === NOTIFICATIONS_PAGE_SIZE);
    } catch (e) {
      if (started === generation.current) setError(errorMessage(e) ?? '読み込めませんでした');
    } finally {
      loadingMore.current = false;
    }
  }

  const sections = useMemo(() => groupByDay(rows ?? []), [rows]);

  return (
    <Screen waves={false}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View>
            <View style={styles.topBar} />
            <Text style={styles.largeTitle} accessibilityRole="header">
              通知
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle} accessibilityRole="header">
            {section.title}
          </Text>
        )}
        renderItem={({ item, index, section }) => {
          // 自分の操作で作られた通知は未読にしない
          const unread = item.actor_user_id !== userId && isUnread(item.created_at, readThrough);
          const last = index === section.data.length - 1;
          return (
            <View style={[styles.cell, index === 0 && styles.cellFirst, last && styles.cellLast]}>
              {index > 0 ? <Separator inset={32} /> : null}
              <Pressable
                onPress={() => open(item)}
                disabled={!notificationTarget(item.data, item.kind)}
                accessibilityRole="button"
                accessibilityLabel={`${unread ? '未読、' : ''}${item.title}、${item.body}`}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={styles.dotBox}>{unread ? <View style={styles.dot} /> : null}</View>
                <View style={styles.body}>
                  <View style={styles.titleLine}>
                    <Text style={[styles.title, unread && styles.titleUnread]}>{item.title}</Text>
                    <Text style={styles.time}>{hourMinute(new Date(item.created_at))}</Text>
                  </View>
                  <Text style={styles.text}>{item.body}</Text>
                </View>
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          rows === null && !error ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.navy} />
            </View>
          ) : (
            <View style={styles.empty}>
              <CenterMessage>{error ?? '通知はありません'}</CenterMessage>
            </View>
          )
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { height: 44 },
  largeTitle: { paddingHorizontal: 20, paddingBottom: 4, fontSize: 34, fontWeight: '700', color: colors.text },
  sectionTitle: {
    paddingTop: 18,
    paddingHorizontal: 20,
    paddingBottom: 8,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  cell: { marginHorizontal: 16, backgroundColor: colors.card, overflow: 'hidden' },
  cellFirst: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  cellLast: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },
  row: { flexDirection: 'row', gap: 8, padding: 12 },
  pressed: { backgroundColor: colors.separator },
  dotBox: { width: 12, alignItems: 'center', paddingTop: 7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.navy },
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, color: colors.text },
  titleUnread: { fontWeight: '600' },
  time: { fontSize: 14, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  text: { fontSize: 14, lineHeight: 21, color: colors.textTertiary },
  empty: { paddingTop: 120 },
});
