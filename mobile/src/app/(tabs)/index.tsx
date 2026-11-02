import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AssistantBar } from '../../components/AssistantBar';
import { ChevronLeft, ChevronRight } from '../../components/icons';
import { type CalendarMode, monthCalendarHeight, ReservationCalendar } from '../../components/ReservationCalendar';
import { ReservationRow } from '../../components/ReservationRow';
import { Screen } from '../../components/Screen';
import { Card, CenterMessage, NavTextButton, PrimaryButton, Segmented, Separator } from '../../components/ui';
import {
  addDays,
  customerLabel,
  dayRange,
  isSameDay,
  LIST_RANGE_DAYS,
  monthRange,
  nextReservation,
  type Reservation,
  reservationSections,
  startOfDayDate,
  weekRange,
} from '../../domain/reservation';
import { type BusinessHour, isClosedOn } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { useBadges } from '../../lib/badges';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { hourMinute, monthDay, sectionTitle } from '../../lib/format';
import { colors, radius } from '../../theme';

type ViewMode = 'list' | CalendarMode;

const VIEW_OPTIONS = [
  { value: 'list', label: '一覧' },
  { value: 'day', label: '日' },
  { value: 'week', label: '週' },
  { value: 'month', label: '月' },
] as const;

function openReservation(reservation: Reservation) {
  router.push({
    pathname: '/reservations/[id]',
    params: { id: reservation.id },
  });
}

function rangeFor(view: ViewMode, date: Date) {
  if (view === 'day') return dayRange(date);
  if (view === 'week') return weekRange(date);
  if (view === 'month') return monthRange(date);
  const today = startOfDayDate(new Date());
  return { from: today, to: addDays(today, LIST_RANGE_DAYS) };
}

function titleFor(view: ViewMode, date: Date): string {
  if (view === 'month') return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  if (view === 'week') {
    const { from } = weekRange(date);
    const last = addDays(from, 6);
    return `${from.getMonth() + 1}月${from.getDate()}日〜${last.getMonth() + 1}月${last.getDate()}日`;
  }
  return isSameDay(date, new Date()) ? `今日　${monthDay(date)}` : monthDay(date);
}

// 前後の移動。月は月初へ、日と週は日数で動かす
function shiftDate(view: ViewMode, date: Date, delta: number): Date {
  if (view === 'month') return new Date(date.getFullYear(), date.getMonth() + delta, 1);
  return addDays(date, view === 'week' ? delta * 7 : delta);
}

function ApprovalBand({ count, compact }: { count: number; compact?: boolean }) {
  return (
    <Pressable
      onPress={() => router.push('/reservations/approvals')}
      accessibilityRole="button"
      accessibilityLabel={`承認待ち ${count}件`}
      style={({ pressed }) => [styles.band, compact && styles.bandCompact, pressed && styles.pressedBand]}
    >
      <Text style={[styles.bandLabel, compact && styles.bandLabelCompact]}>承認待ち</Text>
      <Text style={[styles.bandCount, compact && styles.bandLabelCompact]}>{`${count}件`}</Text>
      <ChevronRight color="#FFFFFF" />
    </Pressable>
  );
}

function DateNav({ title, onPrevious, onNext, unit }: { title: string; onPrevious: () => void; onNext: () => void; unit: string }) {
  return (
    <View style={styles.dateNav}>
      <Pressable
        onPress={onPrevious}
        accessibilityRole="button"
        accessibilityLabel={`前の${unit}`}
        style={({ pressed }) => [styles.dateButton, pressed && styles.pressed]}
      >
        <ChevronLeft />
      </Pressable>
      <Text style={styles.dateTitle} accessibilityRole="header">
        {title}
      </Text>
      <Pressable
        onPress={onNext}
        accessibilityRole="button"
        accessibilityLabel={`次の${unit}`}
        style={({ pressed }) => [styles.dateButton, pressed && styles.pressed]}
      >
        <ChevronRight color={colors.navy} size={24} />
      </Pressable>
    </View>
  );
}

function NextReservationCard({
  reservation,
  busy,
  onArrive,
}: {
  reservation: Reservation;
  busy: boolean;
  onArrive: () => void;
}) {
  const startsAt = new Date(reservation.starts_at);
  // 到着を記録できるのは当日の予約だけ。別の日なら日付も出す
  const isToday = isSameDay(startsAt, new Date());
  return (
    <View style={styles.nextCard}>
      <Pressable
        onPress={() => openReservation(reservation)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.nextBody, pressed && styles.pressed]}
      >
        {isToday ? null : <Text style={styles.nextDate}>{monthDay(startsAt)}</Text>}
        <View style={styles.nextTimes}>
          <Text style={styles.nextStart}>{hourMinute(startsAt)}</Text>
          <Text style={styles.nextEnd}>{`〜${hourMinute(new Date(reservation.ends_at))}`}</Text>
        </View>
        <Text style={styles.nextName}>{customerLabel(reservation)}</Text>
        {reservation.service_name ? <Text style={styles.nextService}>{reservation.service_name}</Text> : null}
      </Pressable>
      {isToday ? <PrimaryButton label="到着を記録" loading={busy} onPress={onArrive} /> : null}
    </View>
  );
}

export default function ReservationsScreen() {
  const household = useHousehold();
  const { pending, refresh: refreshBadges } = useBadges();
  const [view, setView] = useState<ViewMode>('day');
  const [date, setDate] = useState(() => startOfDayDate(new Date()));
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [hours, setHours] = useState<BusinessHour[]>([]);
  // Square はアプリから予約を足せない
  const [canCreate, setCanCreate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [arriving, setArriving] = useState(false);
  const [areaHeight, setAreaHeight] = useState(0);
  // 日や月を速く移動したとき、遅れて届いた前の結果で上書きしない
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const { reservations } = await repositories.reservations.list(rangeFor(view, date));
      if (current === request.current) {
        setRows(reservations);
        setError(null);
      }
    } catch (e) {
      if (current === request.current) setError(errorMessage(e) ?? '読み込めませんでした');
    }
  }, [view, date]);

  // 画面に戻るたび、切り替えたとき、日付を動かしたときに読み直す（写しを持たず毎回読む）
  useFocusEffect(
    useCallback(() => {
      load();
      repositories.providers
        .getState()
        .then((state) => setCanCreate(state.capabilities.create))
        .catch(() => setCanCreate(true));
      repositories.shop
        .getProfile(household.id)
        .then((profile) => setHours(profile?.business_hours ?? []))
        .catch(() => undefined);
    }, [household.id, load]),
  );

  async function refresh() {
    setRefreshing(true);
    refreshBadges();
    await load();
    setRefreshing(false);
  }

  function addReservation(at?: Date) {
    router.push({ pathname: '/reservations/edit', params: at ? { date: at.toISOString() } : {} });
  }

  function openDay(day: Date) {
    setDate(startOfDayDate(day));
    setView('day');
  }

  function changeView(next: ViewMode) {
    // 一覧は今日からなので、一覧から日へ移るときは今日を出す
    if (next !== 'list' && view === 'list') setDate(startOfDayDate(new Date()));
    setView(next);
  }

  async function arrive(reservation: Reservation) {
    setArriving(true);
    try {
      await repositories.reservations.arrive(reservation.id);
      await load();
    } catch (e) {
      Alert.alert('到着を記録できませんでした', errorMessage(e) ?? '');
    } finally {
      setArriving(false);
    }
  }

  const sections = useMemo(() => reservationSections(rows ?? []), [rows]);
  const next = useMemo(() => nextReservation(rows ?? [], new Date()), [rows]);
  const isCalendar = view !== 'list';
  const closedDay = view === 'day' && isClosedOn(hours, date) && (rows ?? []).length === 0;
  const unit = view === 'month' ? '月' : view === 'week' ? '週' : '日';

  const calendar =
    view === 'list' ? null : (
      <ReservationCalendar
        mode={view}
        date={date}
        height={view === 'month' ? monthCalendarHeight(date) : areaHeight}
        reservations={rows ?? []}
        hours={hours}
        onPressReservation={openReservation}
        onPressTime={canCreate ? addReservation : undefined}
        onPressDay={openDay}
        onSwipe={setDate}
      />
    );

  return (
    <Screen waves={false}>
      <View style={styles.topBar}>
        {canCreate ? <NavTextButton label="追加" accessibilityLabel="予約を追加" onPress={() => addReservation()} /> : null}
      </View>
      <Text style={styles.largeTitle} accessibilityRole="header">
        予約
      </Text>
      <Segmented options={VIEW_OPTIONS} value={view} onChange={changeView} />

      {view === 'list' ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} />}
        >
          {pending > 0 ? <ApprovalBand count={pending} /> : null}
          {error ? (
            <View style={styles.message}>
              <CenterMessage>{error}</CenterMessage>
            </View>
          ) : rows === null ? (
            <View style={styles.message}>
              <ActivityIndicator color={colors.navy} />
            </View>
          ) : sections.length === 0 ? (
            <View style={styles.message}>
              <CenterMessage>予約はありません</CenterMessage>
            </View>
          ) : (
            <>
              {next ? (
                <>
                  <Text style={styles.sectionTitle} accessibilityRole="header">
                    次の予約
                  </Text>
                  <NextReservationCard reservation={next} busy={arriving} onArrive={() => arrive(next)} />
                </>
              ) : null}
              {sections.map((section) => (
                <View key={section.date.toISOString()}>
                  <Text style={styles.sectionTitle} accessibilityRole="header">
                    {sectionTitle(section.date)}
                  </Text>
                  <Card>
                    {section.data.map((reservation, index) => (
                      <View key={reservation.id}>
                        {index > 0 ? <Separator /> : null}
                        <ReservationRow reservation={reservation} onPress={() => openReservation(reservation)} />
                      </View>
                    ))}
                  </Card>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      ) : null}

      {isCalendar ? (
        <>
          {view === 'day' && pending > 0 ? <ApprovalBand count={pending} compact /> : null}
          <DateNav
            title={titleFor(view, date)}
            unit={unit}
            onPrevious={() => setDate(shiftDate(view, date, -1))}
            onNext={() => setDate(shiftDate(view, date, 1))}
          />
          {error ? (
            <View style={styles.flex}>
              <CenterMessage>{error}</CenterMessage>
            </View>
          ) : closedDay ? (
            <View style={styles.flex}>
              <View style={styles.closedCard}>
                <Text style={styles.closedLabel}>定休日</Text>
              </View>
            </View>
          ) : view === 'month' ? (
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.monthContent}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} />}
            >
              <View style={styles.calendarCard}>{calendar}</View>
            </ScrollView>
          ) : (
            <View style={[styles.flex, styles.calendarArea]}>
              <View
                style={[styles.calendarCard, styles.flex, view === 'day' ? styles.dayCard : styles.weekCard]}
                onLayout={(event) => setAreaHeight(event.nativeEvent.layout.height - (view === 'day' ? 24 : 20))}
              >
                {areaHeight > 0 ? calendar : null}
              </View>
            </View>
          )}
        </>
      ) : null}

      <AssistantBar onPress={() => router.push('/assistant')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topBar: { height: 44, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 8 },
  largeTitle: { paddingHorizontal: 20, paddingBottom: 12, fontSize: 34, fontWeight: '700', color: colors.text },
  listContent: { paddingBottom: 16 },
  pressed: { opacity: 0.5 },
  band: {
    marginTop: 16,
    marginHorizontal: 16,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 12,
    borderRadius: radius.card,
    backgroundColor: colors.navy,
  },
  bandCompact: { marginTop: 12, minHeight: 44 },
  pressedBand: { backgroundColor: colors.navyPressed },
  bandLabel: { flex: 1, fontSize: 17, fontWeight: '600', color: '#FFFFFF' },
  bandCount: { fontSize: 17, fontWeight: '600', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  bandLabelCompact: { fontSize: 15 },
  sectionTitle: {
    paddingTop: 18,
    paddingHorizontal: 20,
    paddingBottom: 8,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  nextCard: { marginHorizontal: 16, padding: 16, gap: 14, borderRadius: radius.section, backgroundColor: colors.card },
  nextBody: { gap: 4 },
  nextDate: { fontSize: 15, fontWeight: '600', color: colors.navy, fontVariant: ['tabular-nums'] },
  nextTimes: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  nextStart: { fontSize: 34, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  nextEnd: { fontSize: 17, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  nextName: { fontSize: 20, lineHeight: 28, fontWeight: '600', color: colors.text },
  nextService: { fontSize: 15, lineHeight: 22, color: colors.textTertiary },
  message: { minHeight: 240 },
  dateNav: { height: 44, flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 4, marginHorizontal: 8 },
  dateButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  dateTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: colors.text },
  calendarArea: { paddingBottom: 12 },
  calendarCard: { marginHorizontal: 16, borderRadius: radius.section, backgroundColor: colors.card, overflow: 'hidden' },
  dayCard: { paddingTop: 12, paddingBottom: 12, paddingRight: 8 },
  weekCard: { paddingTop: 8, paddingBottom: 12, paddingRight: 4 },
  monthContent: { paddingBottom: 12 },
  closedCard: {
    marginHorizontal: 16,
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: radius.card,
    backgroundColor: colors.card,
  },
  closedLabel: { fontSize: 17, color: colors.textSecondary },
});
