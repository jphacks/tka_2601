import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Gear } from '../components/icons';
import { Screen } from '../components/Screen';
import { CenterMessage, Separator } from '../components/ui';
import { VisitRow } from '../components/VisitRow';
import { listVisits, VISITS_PAGE_SIZE } from '../lib/api';
import { useHousehold } from '../lib/auth';
import { errorMessage } from '../lib/errors';
import { dayKey, sectionTitle } from '../lib/format';
import type { VisitSummary } from '../lib/types';
import { colors, radius } from '../theme';

type Section = { key: string; title: string; data: VisitSummary[] };

function groupByDay(visits: VisitSummary[]): Section[] {
  const now = new Date();
  const sections: Section[] = [];
  for (const visit of visits) {
    const date = new Date(visit.chimed_at);
    const key = dayKey(date);
    const last = sections[sections.length - 1];
    if (last?.key === key) last.data.push(visit);
    else sections.push({ key, title: sectionTitle(date, now), data: [visit] });
  }
  return sections;
}

export default function VisitListScreen() {
  const household = useHousehold();
  const insets = useSafeAreaInsets();
  const [visits, setVisits] = useState<VisitSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadingMore = useRef(false);
  const page = useRef(0);

  const loadFirstPage = useCallback(async () => {
    try {
      const rows = await listVisits(household.id, 0);
      page.current = 0;
      setVisits(rows);
      setHasMore(rows.length === VISITS_PAGE_SIZE);
      setError(null);
    } catch (e) {
      setError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, [household.id]);

  // 画面に戻るたびに読み直す（詳細で消したときも反映する）
  useFocusEffect(
    useCallback(() => {
      loadFirstPage();
    }, [loadFirstPage]),
  );

  async function refresh() {
    setRefreshing(true);
    await loadFirstPage();
    setRefreshing(false);
  }

  async function loadMore() {
    if (!hasMore || loadingMore.current || !visits) return;
    loadingMore.current = true;
    try {
      const next = await listVisits(household.id, page.current + 1);
      page.current += 1;
      setVisits((current) => [...(current ?? []), ...next]);
      setHasMore(next.length === VISITS_PAGE_SIZE);
    } finally {
      loadingMore.current = false;
    }
  }

  const sections = useMemo(() => groupByDay(visits ?? []), [visits]);

  const header = (
    <View>
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel="設定"
          style={({ pressed }) => [styles.gear, pressed && styles.pressed]}
        >
          <Gear />
        </Pressable>
      </View>
      <Text style={styles.largeTitle} accessibilityRole="header">
        来客
      </Text>
    </View>
  );

  return (
    <Screen>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle} accessibilityRole="header">
            {section.title}
          </Text>
        )}
        renderItem={({ item, index, section }) => {
          const first = index === 0;
          const last = index === section.data.length - 1;
          return (
            <View style={[styles.cell, first && styles.cellFirst, last && styles.cellLast]}>
              {first ? null : <Separator />}
              <VisitRow visit={item} onPress={() => router.push({ pathname: '/visits/[id]', params: { id: item.id } })} />
            </View>
          );
        }}
        ListEmptyComponent={
          visits === null && !error ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.navy} />
            </View>
          ) : (
            <View style={styles.empty}>
              <CenterMessage>{error ?? '来客の記録はありません'}</CenterMessage>
            </View>
          )
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { height: 44, flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 8 },
  gear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.5 },
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
  empty: { paddingTop: 120 },
});
