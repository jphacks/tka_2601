import 'dayjs/locale/ja';

import type { Dayjs } from 'dayjs';
import { useCallback, useMemo } from 'react';
import { Platform, Pressable, StyleSheet, Text, TouchableOpacity, type TouchableOpacityProps, View, type ViewStyle } from 'react-native';
import { Calendar, type CalendarTouchableOpacityProps, type ICalendarEventBase } from 'react-native-big-calendar';

import {
  calendarEnd,
  customerLabel,
  datesInRange,
  dayRange,
  isSameDay,
  monthWeekCount,
  type Reservation,
  weekRange,
} from '../domain/reservation';
import { type BusinessHour, isClosedOn, visibleHours } from '../domain/shop';
import { timeRange } from '../lib/format';
import { colors } from '../theme';

export type CalendarMode = 'day' | 'week' | 'month';

type CalendarEvent = ICalendarEventBase & { reservation: Reservation };

const DAY_HOUR_HEIGHT = 64;
const WEEK_HOUR_HEIGHT = 44;
const WEEK_HEADER_HEIGHT = 52;
const MONTH_CELL_HEIGHT = 92;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const THEME = {
  palette: {
    primary: { main: colors.navy, contrastText: '#FFFFFF' },
    nowIndicator: colors.text,
    gray: {
      100: colors.separator,
      200: colors.separator,
      300: colors.border,
      500: colors.textSecondary,
      800: colors.text,
    },
    moreLabel: colors.navy,
  },
  typography: {
    xs: { fontSize: 12, fontWeight: '600' as const },
    sm: { fontSize: 13 },
    xl: { fontSize: 14 },
    moreLabel: { fontSize: 11, fontWeight: '600' as const },
  },
};

// 月の表示に要る高さ
export function monthCalendarHeight(date: Date): number {
  return monthWeekCount(date) * MONTH_CELL_HEIGHT;
}

function DayHour({ hour }: { hour: number }) {
  return <Text style={styles.dayHour}>{`${hour}:00`}</Text>;
}

function WeekHour({ hour }: { hour: number }) {
  return <Text style={styles.weekHour}>{hour}</Text>;
}

// 日の表示は画面の上で日付を出すので、ライブラリの見出しを出さない
function NoHeader() {
  return null;
}

function WeekHeader({ dateRange, onPressDateHeader }: { dateRange: Dayjs[]; onPressDateHeader?: (date: Date) => void }) {
  const today = new Date();
  return (
    <View style={styles.weekHeader}>
      <View style={styles.hourColumn} />
      {dateRange.map((item) => {
        const date = item.toDate();
        const isToday = isSameDay(date, today);
        return (
          <Pressable
            key={item.toString()}
            onPress={() => onPressDateHeader?.(date)}
            accessibilityRole="button"
            accessibilityLabel={`${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`}
            style={styles.weekHeaderCell}
          >
            <Text style={styles.weekHeaderDay}>{WEEKDAYS[date.getDay()]}</Text>
            <View style={[styles.weekHeaderDate, isToday && styles.today]}>
              <Text style={[styles.weekHeaderDateText, isToday && styles.todayText]}>{date.getDate()}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function eventColors(reservation: Reservation): { background: string; foreground: string; dashed: boolean } {
  if (reservation.arrived_at) return { background: colors.navy, foreground: '#FFFFFF', dashed: false };
  if (reservation.status === 'pending') return { background: colors.card, foreground: colors.navy, dashed: true };
  return { background: colors.navyTint, foreground: colors.navy, dashed: false };
}

function eventLabel(reservation: Reservation): string {
  return [
    timeRange(reservation.starts_at, reservation.ends_at),
    customerLabel(reservation),
    reservation.service_name,
    reservation.arrived_at ? '到着済み' : reservation.status === 'pending' ? '仮予約' : null,
  ]
    .filter(Boolean)
    .join('、');
}

export function ReservationCalendar({
  mode,
  date,
  height,
  reservations,
  hours,
  onPressReservation,
  onPressTime,
  onPressDay,
  onSwipe,
}: {
  mode: CalendarMode;
  date: Date;
  // 表示に使える高さ
  height: number;
  reservations: readonly Reservation[];
  hours: readonly BusinessHour[];
  onPressReservation: (reservation: Reservation) => void;
  // 日と週で空いている時間を押したとき
  onPressTime?: (date: Date) => void;
  // 週の見出しと、月の日付を押したとき
  onPressDay: (date: Date) => void;
  onSwipe: (date: Date) => void;
}) {
  const active = useMemo(() => reservations.filter((row) => row.status !== 'cancelled'), [reservations]);
  const events = useMemo<CalendarEvent[]>(
    () =>
      active.map((reservation) => ({
        title: reservation.customer_name,
        start: new Date(reservation.starts_at),
        end: calendarEnd(new Date(reservation.starts_at), new Date(reservation.ends_at)),
        reservation,
      })),
    [active],
  );

  const { firstHour, lastHour } = useMemo(() => {
    const dates = datesInRange(mode === 'day' ? dayRange(date) : weekRange(date));
    return visibleHours(hours, dates, active);
  }, [active, date, hours, mode]);

  const eventCellStyle = useCallback(
    (event: CalendarEvent): ViewStyle => {
      const { background, dashed } = eventColors(event.reservation);
      return {
        backgroundColor: background,
        borderWidth: dashed ? 1 : 0,
        borderStyle: 'dashed',
        borderColor: colors.navy,
        borderRadius: mode === 'day' ? 8 : 4,
        padding: mode === 'day' ? 6 : mode === 'week' ? 2 : 0,
        paddingHorizontal: mode === 'day' ? 10 : mode === 'week' ? 2 : 3,
        shadowOpacity: 0,
        elevation: 0,
        minWidth: 0,
      };
    },
    [mode],
  );

  const renderEvent = useCallback(
    (event: CalendarEvent, touchable: CalendarTouchableOpacityProps) => {
      const { key, ...props } = touchable;
      const reservation = event.reservation;
      const { foreground } = eventColors(reservation);
      const pending = reservation.status === 'pending' && !reservation.arrived_at;
      return (
        <TouchableOpacity
          key={key}
          {...(props as TouchableOpacityProps)}
          accessibilityRole="button"
          accessibilityLabel={eventLabel(reservation)}
        >
          {mode === 'day' ? (
            <>
              <View style={styles.eventTitle}>
                <Text style={[styles.dayName, { color: foreground }]} numberOfLines={1}>
                  {customerLabel(reservation)}
                </Text>
                {pending ? (
                  <View style={styles.eventBadge}>
                    <Text style={styles.eventBadgeText}>仮予約</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.dayDetail, { color: foreground }]} numberOfLines={1}>
                {[
                  timeRange(reservation.starts_at, reservation.ends_at),
                  reservation.service_name,
                  reservation.arrived_at ? '到着済み' : null,
                ]
                  .filter(Boolean)
                  .join('　')}
              </Text>
            </>
          ) : (
            <Text style={[styles.shortName, { color: foreground }]} numberOfLines={1}>
              {reservation.customer_name}
            </Text>
          )}
        </TouchableOpacity>
      );
    },
    [mode],
  );

  const calendarCellStyle = useCallback(
    (cell?: Date): ViewStyle => (cell && isClosedOn(hours, cell) ? { backgroundColor: colors.background } : {}),
    [hours],
  );

  const renderMonthDate = useCallback(
    (cell: Date) => {
      const isToday = isSameDay(cell, new Date());
      return (
        <View style={[styles.monthDate, isToday && styles.today]}>
          <Text
            style={[
              styles.monthDateText,
              isClosedOn(hours, cell) && styles.closedText,
              isToday && styles.todayText,
            ]}
          >
            {cell.getDate()}
          </Text>
        </View>
      );
    },
    [hours],
  );

  const hourHeight = mode === 'week' ? WEEK_HOUR_HEIGHT : DAY_HOUR_HEIGHT;

  // 今を含む日と週は、現在時刻の少し上から見せる
  const scrollOffset = useMemo(() => {
    if (mode === 'month') return 0;
    const now = new Date();
    const dates = datesInRange(mode === 'day' ? dayRange(date) : weekRange(date));
    if (!dates.some((item) => isSameDay(item, now))) return 0;
    const minutes = Math.max((now.getHours() - firstHour - 1) * 60 + now.getMinutes(), 0);
    // ライブラリは iOS だけこの値をピクセルとして使う
    return Platform.OS === 'ios' ? (minutes / 60) * hourHeight : minutes;
  }, [date, firstHour, hourHeight, mode]);

  if (mode === 'month') {
    return (
      <Calendar<CalendarEvent>
        key="month"
        mode="month"
        date={date}
        events={events}
        height={height}
        locale="ja"
        weekStartsOn={0}
        theme={THEME}
        showAdjacentMonths={false}
        maxVisibleEventCount={2}
        moreLabel="+{moreCount}"
        eventMinHeightForMonthView={18}
        disableMonthEventCellPress
        eventCellStyle={eventCellStyle}
        renderEvent={renderEvent}
        calendarCellStyle={calendarCellStyle}
        renderCustomDateForMonth={renderMonthDate}
        onPressCell={onPressDay}
        onPressDateHeader={onPressDay}
        onSwipeEnd={onSwipe}
      />
    );
  }

  return (
    <Calendar<CalendarEvent>
      // 時間帯が変わるとスクロールの位置も変わるので作り直す
      key={`${mode}:${firstHour}:${lastHour}`}
      mode={mode}
      date={date}
      events={events}
      // ライブラリは本体の高さを height - 行の高さ × 3 にする
      height={height + hourHeight * 3 - (mode === 'week' ? WEEK_HEADER_HEIGHT : 0)}
      hourRowHeight={hourHeight}
      scrollOffsetMinutes={scrollOffset}
      minHour={firstHour}
      maxHour={lastHour}
      ampm={false}
      locale="ja"
      weekStartsOn={0}
      theme={THEME}
      showAllDayEventCell={false}
      overlapOffset={8}
      // 既定の処理は日にちだけで並べるので、週が月をまたぐと重なりを見落とす
      enableEnrichedEvents
      eventCellStyle={eventCellStyle}
      renderEvent={renderEvent}
      renderHeader={(mode === 'week' ? WeekHeader : NoHeader) as never}
      hourComponent={mode === 'week' ? WeekHour : DayHour}
      calendarCellStyle={calendarCellStyle}
      onPressCell={onPressTime}
      onPressEvent={(event) => onPressReservation(event.reservation)}
      onPressDateHeader={onPressDay}
      onSwipeEnd={onSwipe}
    />
  );
}

const styles = StyleSheet.create({
  dayHour: { paddingRight: 6, textAlign: 'right', fontSize: 13, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  weekHour: { paddingRight: 6, textAlign: 'right', fontSize: 11, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  hourColumn: { width: 50 },
  weekHeader: { height: WEEK_HEADER_HEIGHT, flexDirection: 'row' },
  weekHeaderCell: { flex: 1, alignItems: 'center', gap: 2 },
  weekHeaderDay: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  weekHeaderDate: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  weekHeaderDateText: { fontSize: 14, color: colors.text, fontVariant: ['tabular-nums'] },
  today: { backgroundColor: colors.navy },
  todayText: { fontWeight: '700', color: '#FFFFFF' },
  eventTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dayName: { flexShrink: 1, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  dayDetail: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  eventBadge: { paddingHorizontal: 6, borderRadius: 6, backgroundColor: colors.navyTint },
  eventBadgeText: { fontSize: 11, lineHeight: 18, fontWeight: '700', color: colors.navy },
  shortName: { fontSize: 11, fontWeight: '600', lineHeight: 16 },
  monthDate: {
    alignSelf: 'center',
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthDateText: { fontSize: 13, color: colors.text, fontVariant: ['tabular-nums'] },
  closedText: { color: colors.textSecondary },
});
