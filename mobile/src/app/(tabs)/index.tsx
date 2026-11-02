import SegmentedControlClass, { type SegmentedControlProps } from '@react-native-segmented-control/segmented-control';
import { router, useFocusEffect } from 'expo-router';
import { type ComponentType, useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-screens/experimental';

import { AssistantBar } from '../../components/AssistantBar';
import { Icon } from '../../components/Icon';
import { ChevronLeft, ChevronRight } from '../../components/icons';
import { type CalendarMode, monthCalendarHeight, ReservationCalendar } from '../../components/ReservationCalendar';
import { ReservationRow } from '../../components/ReservationRow';
import { Screen } from '../../components/Screen';
import { Card, CenterMessage, IntentBadge, LargeTitle, PrimaryButton, Separator, SoftButton } from '../../components/ui';
import {
  addDays,
  canRecordArrival,
  customerLabel,
  dayRange,
  isSameDay,
  LIST_RANGE_DAYS,
  monthRange,
  nextReservation,
  PENDING_RANGE_DAYS,
  pendingByStart,
  type Reservation,
  type ReservationProvider,
  reservationSections,
  startOfDayDate,
  weekRange,
  withoutPending,
} from '../../domain/reservation';
import { type BusinessHour, isClosedOn } from '../../domain/shop';
import { useHousehold } from '../../lib/auth';
import { useBadges } from '../../lib/badges';
import { confirmAction } from '../../lib/confirm';
import { useLiveRefresh } from '../../lib/liveRefresh';
import { repositories } from '../../lib/container';
import { errorMessage } from '../../lib/errors';
import { dateTimeRange, hourMinute, monthDay, sectionTitle } from '../../lib/format';
import { approveDialogTitle } from '../../lib/labels';
import { SYMBOLS } from '../../lib/symbols';
import { colors, radius } from '../../theme';

// ライブラリの型は今の React Native の型と合わず、JSX に使えない
const SegmentedControl = SegmentedControlClass as unknown as ComponentType<SegmentedControlProps>;

type ViewMode = 'list' | CalendarMode;

const VIEW_ORDER: readonly ViewMode[] = ['list', 'day', 'week', 'month'];
const VIEW_LABELS = ['一覧', '日', '週', '月'];

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
  // 別の日なら日付も出す
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
      {canRecordArrival(reservation, new Date()) ? (
        <PrimaryButton
          label="到着を記録"
          icon={<Icon name={SYMBOLS.arrived} size={20} color="#FFFFFF" />}
          loading={busy}
          onPress={onArrive}
        />
      ) : null}
    </View>
  );
}

// 店の確認を待つ仮予約。読み取りだけの予約は、押して詳細を見るだけにする
function PendingCard({
  reservation,
  busy,
  onApprove,
  onDecline,
}: {
  reservation: Reservation;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <View style={styles.pendingCard}>
      <Pressable
        onPress={() => openReservation(reservation)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.pendingHead, pressed && styles.pressed]}
      >
        <View style={styles.pendingBody}>
          <Text style={styles.pendingWhen}>{dateTimeRange(reservation.starts_at, reservation.ends_at)}</Text>
          <View style={styles.pendingTitle}>
            <Text style={[styles.nextName, styles.pendingName]} numberOfLines={1}>
              {customerLabel(reservation)}
            </Text>
            <IntentBadge label="仮予約" />
          </View>
          {reservation.service_name ? <Text style={styles.nextService}>{reservation.service_name}</Text> : null}
        </View>
        <ChevronRight />
      </Pressable>
      {reservation.read_only ? null : (
        <View style={styles.pendingActions}>
          <SoftButton
            compact
            label="お断り"
            icon={<Icon name={SYMBOLS.decline} size={18} weight="semibold" />}
            disabled={busy}
            onPress={onDecline}
            style={styles.flex}
          />
          <PrimaryButton
            compact
            label="承認"
            icon={<Icon name={SYMBOLS.approve} size={18} color="#FFFFFF" weight="semibold" />}
            loading={busy}
            onPress={onApprove}
            style={styles.flex}
          />
        </View>
      )}
    </View>
  );
}

export default function ReservationsScreen() {
  const household = useHousehold();
  const { refresh: refreshBadges } = useBadges();
  const [view, setView] = useState<ViewMode>('list');
  const [date, setDate] = useState(() => startOfDayDate(new Date()));
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [pendingRows, setPendingRows] = useState<Reservation[]>([]);
  const [provider, setProvider] = useState<ReservationProvider | null>(null);
  const [hours, setHours] = useState<BusinessHour[]>([]);
  // Square はアプリから予約を足せない
  const [canCreate, setCanCreate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [arriving, setArriving] = useState(false);
  // 処理中の仮予約。同じ予約を二重に操作させない
  const [processing, setProcessing] = useState<readonly string[]>([]);
  const [areaHeight, setAreaHeight] = useState(0);
  // 日や月を速く移動したとき、続けて操作したとき、遅れて届いた前の結果で上書きしない
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const today = startOfDayDate(new Date());
      const [{ reservations }, pending] = await Promise.all([
        repositories.reservations.list(rangeFor(view, date)),
        // 仮予約のカードは一覧にだけ出す。一覧より先の日まで見る
        view === 'list'
          ? repositories.reservations.list({ from: today, to: addDays(today, PENDING_RANGE_DAYS) }, 'pending')
          : null,
      ]);
      if (current !== request.current) return;
      setRows(reservations);
      if (pending) {
        setPendingRows(pendingByStart(pending.reservations));
        setProvider(pending.provider);
      }
      setError(null);
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

  // 開いたまま日付が変わっていたら今日へ戻す。日付が変わると上の処理が読み直す
  const lastDay = useRef(startOfDayDate(new Date()));
  useLiveRefresh(() => {
    const today = startOfDayDate(new Date());
    if (isSameDay(today, lastDay.current)) {
      load();
      return;
    }
    lastDay.current = today;
    setDate(today);
  });

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

  async function decide(action: (id: string) => Promise<void>, reservation: Reservation, failure: string) {
    setProcessing((current) => [...current, reservation.id]);
    try {
      await action(reservation.id);
      await load();
      refreshBadges();
    } catch (e) {
      Alert.alert(failure, errorMessage(e) ?? '');
    } finally {
      setProcessing((current) => current.filter((id) => id !== reservation.id));
    }
  }

  function approve(reservation: Reservation) {
    confirmAction({
      title: approveDialogTitle(provider),
      confirmLabel: '承認',
      cancelLabel: '戻る',
      onConfirm: () => decide(repositories.reservations.approve, reservation, '承認できませんでした'),
    });
  }

  function decline(reservation: Reservation) {
    confirmAction({
      title: 'この予約をお断りしますか',
      confirmLabel: 'お断り',
      cancelLabel: '戻る',
      onConfirm: () => decide(repositories.reservations.cancel, reservation, 'お断りできませんでした'),
    });
  }

  // 仮予約はカードで出すので、日付の見出しの下には並べない
  const sections = useMemo(() => reservationSections(withoutPending(rows ?? [])), [rows]);
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
    <SafeAreaView edges={{ bottom: true }} style={styles.safeArea}>
    <Screen waves={false}>
      <LargeTitle
        title="予約"
        right={
          canCreate ? (
            <Pressable
              onPress={() => addReservation(view === 'day' || view === 'week' ? date : undefined)}
              accessibilityRole="button"
              accessibilityLabel="予約を追加"
              style={({ pressed }) => [styles.addButton, pressed && styles.addPressed]}
            >
              <Icon name={SYMBOLS.plus} size={24} color="#FFFFFF" weight="semibold" />
            </Pressable>
          ) : null
        }
      />
      <SegmentedControl
        values={VIEW_LABELS}
        selectedIndex={VIEW_ORDER.indexOf(view)}
        onChange={(event) => changeView(VIEW_ORDER[event.nativeEvent.selectedSegmentIndex])}
        style={styles.segmented}
      />

      {view === 'list' ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.navy} />}
        >
          {error ? (
            <View style={styles.message}>
              <CenterMessage>{error}</CenterMessage>
            </View>
          ) : rows === null ? (
            <View style={styles.message}>
              <ActivityIndicator color={colors.navy} />
            </View>
          ) : sections.length === 0 && pendingRows.length === 0 ? (
            <View style={styles.message}>
              <CenterMessage>予約はありません</CenterMessage>
            </View>
          ) : (
            <>
              {next ? (
                <>
                  <View style={styles.nextHead}>
                    <Icon name={SYMBOLS.clock} size={17} color={colors.textTertiary} />
                    <Text style={styles.nextLabel} accessibilityRole="header">
                      次の予約
                    </Text>
                  </View>
                  <NextReservationCard reservation={next} busy={arriving} onArrive={() => arrive(next)} />
                </>
              ) : null}
              {pendingRows.length > 0 ? (
                <View style={[styles.pendingList, !next && styles.pendingListFirst]}>
                  {pendingRows.map((reservation) => (
                    <PendingCard
                      key={reservation.id}
                      reservation={reservation}
                      busy={processing.includes(reservation.id)}
                      onApprove={() => approve(reservation)}
                      onDecline={() => decline(reservation)}
                    />
                  ))}
                </View>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.navy,
  },
  addPressed: { backgroundColor: colors.navyPressed },
  segmented: { marginTop: 8, marginHorizontal: 16 },
  listContent: { paddingBottom: 16 },
  pressed: { opacity: 0.5 },
  sectionTitle: {
    paddingTop: 18,
    paddingHorizontal: 20,
    paddingBottom: 8,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textTertiary,
  },
  nextHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 18,
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  nextLabel: { fontSize: 15, fontWeight: '600', color: colors.textTertiary },
  nextCard: { marginHorizontal: 16, padding: 16, gap: 14, borderRadius: radius.section, backgroundColor: colors.card },
  nextBody: { gap: 4 },
  nextDate: { fontSize: 15, fontWeight: '600', color: colors.navy, fontVariant: ['tabular-nums'] },
  nextTimes: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  nextStart: { fontSize: 34, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  nextEnd: { fontSize: 17, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  nextName: { fontSize: 20, lineHeight: 28, fontWeight: '600', color: colors.text },
  nextService: { fontSize: 15, lineHeight: 22, color: colors.textTertiary },
  pendingList: { marginTop: 12, marginHorizontal: 16, gap: 12 },
  pendingListFirst: { marginTop: 18 },
  pendingCard: {
    paddingTop: 14,
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
    borderWidth: 2,
    borderColor: colors.navy,
    borderRadius: radius.section,
    backgroundColor: colors.card,
  },
  pendingHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pendingBody: { flex: 1, minWidth: 0, gap: 3 },
  pendingWhen: { fontSize: 15, fontWeight: '600', color: colors.navy, fontVariant: ['tabular-nums'] },
  pendingTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pendingName: { flexShrink: 1 },
  pendingActions: { flexDirection: 'row', gap: 8 },
  message: { minHeight: 240 },
  dateNav: { height: 44, flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 2, marginHorizontal: 8 },
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
