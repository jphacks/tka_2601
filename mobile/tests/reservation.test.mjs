import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  calendarDayKey,
  calendarEnd,
  canRecordArrival,
  customerLabel,
  datesInRange,
  dayRange,
  monthRange,
  monthWeekCount,
  nextReservation,
  reservationsByDay,
  reservationSections,
  weekRange,
  dailySegments,
  newIdempotencyKey,
} from '../src/domain/reservation.ts';
import { keysetFilter } from '../src/domain/collections.ts';
import { appendUnique } from '../src/domain/collections.ts';
import { applyDayHours, isClosedOn, normalizeBusinessHours, visibleHours } from '../src/domain/shop.ts';
import { endClockLabel } from '../src/lib/format.ts';

function reservation(id, startsAt, status = 'confirmed', extra = {}) {
  const start = new Date(startsAt);
  return {
    id,
    customer_name: id,
    customer_phone: null,
    service_name: null,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    status,
    source: 'app',
    note: null,
    arrived_at: null,
    visit_id: null,
    read_only: false,
    ...extra,
  };
}

test('day, week and month ranges start at local midnight', () => {
  const monday = new Date(2026, 10, 2, 14, 30);
  assert.equal(calendarDayKey(dayRange(monday).from), '2026-11-2');
  assert.equal(calendarDayKey(dayRange(monday).to), '2026-11-3');
  assert.equal(calendarDayKey(weekRange(monday).from), '2026-11-1');
  assert.equal(calendarDayKey(weekRange(monday).to), '2026-11-8');
  assert.equal(calendarDayKey(monthRange(monday).from), '2026-11-1');
  assert.equal(calendarDayKey(monthRange(monday).to), '2026-12-1');
  assert.equal(datesInRange(weekRange(monday)).length, 7);
});

test('adding days crosses month boundaries', () => {
  assert.equal(calendarDayKey(addDays(new Date(2026, 10, 30), 1)), '2026-12-1');
});

test('month week count follows a Sunday start', () => {
  assert.equal(monthWeekCount(new Date(2026, 10, 1)), 5);
  assert.equal(monthWeekCount(new Date(2026, 1, 1)), 4);
  assert.equal(monthWeekCount(new Date(2026, 7, 1)), 6);
});

test('reservations are grouped by local day in start order without cancellations', () => {
  const rows = [
    reservation('later', new Date(2026, 10, 2, 15)),
    reservation('cancelled', new Date(2026, 10, 2, 9), 'cancelled'),
    reservation('first', new Date(2026, 10, 2, 10)),
    reservation('next-day', new Date(2026, 10, 3, 10)),
  ];
  const days = reservationsByDay(rows);
  assert.deepEqual(days.get('2026-11-2').map((r) => r.id), ['first', 'later']);
  assert.deepEqual(days.get('2026-11-3').map((r) => r.id), ['next-day']);

  const sections = reservationSections(rows);
  assert.deepEqual(sections.map((s) => s.data.length), [2, 1]);
  assert.equal(calendarDayKey(sections[1].date), '2026-11-3');
});

test('the next reservation is confirmed, not arrived and not finished', () => {
  const now = new Date(2026, 10, 2, 13, 20);
  const rows = [
    reservation('finished', new Date(2026, 10, 2, 10)),
    reservation('arrived', new Date(2026, 10, 2, 13), 'confirmed', { arrived_at: now.toISOString() }),
    reservation('pending', new Date(2026, 10, 2, 13, 30), 'pending'),
    reservation('after', new Date(2026, 10, 2, 16)),
    reservation('next', new Date(2026, 10, 2, 14)),
  ];
  assert.equal(nextReservation(rows, now).id, 'next');
  assert.equal(nextReservation([], now), null);
});

test('external customers keep their calendar title', () => {
  assert.equal(customerLabel({ customer_name: '田中', source: 'app' }), '田中様');
  assert.equal(customerLabel({ customer_name: '田中さん', source: 'external' }), '田中さん');
});

test('business hours are normalized to all seven days with saved values kept', () => {
  const hours = normalizeBusinessHours([{ day: 2, closed: true, open: '09:00', close: '18:00' }]);
  assert.equal(hours.length, 7);
  assert.deepEqual(hours[2], { day: 2, closed: true, open: '09:00', close: '18:00' });
  assert.deepEqual(hours[0], { day: 0, closed: false, open: '10:00', close: '19:00' });
});

test('closed days come from the business hours', () => {
  const hours = normalizeBusinessHours([{ day: 2, closed: true }]);
  assert.equal(isClosedOn(hours, new Date(2026, 10, 3)), true);
  assert.equal(isClosedOn(hours, new Date(2026, 10, 4)), false);
  assert.equal(isClosedOn([], new Date(2026, 10, 3)), false);
});

test('visible hours cover the business hours and reservations', () => {
  const hours = normalizeBusinessHours([]);
  const day = [new Date(2026, 10, 2)];
  assert.deepEqual(visibleHours(hours, day, []), { firstHour: 10, lastHour: 19 });
  const early = reservation('early', new Date(2026, 10, 2, 8, 30));
  const late = { ...reservation('late', new Date(2026, 10, 2, 20)), ends_at: new Date(2026, 10, 2, 21, 30).toISOString() };
  assert.deepEqual(visibleHours(hours, day, [early, late]), { firstHour: 8, lastHour: 22 });
});

test('visible hours fall back when every day is closed and stay valid for the calendar', () => {
  const closed = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, closed: true, open: '10:00', close: '19:00' }));
  assert.deepEqual(visibleHours(closed, [new Date(2026, 10, 3)], []), { firstHour: 10, lastHour: 19 });
  const lateNight = { ...reservation('n', new Date(2026, 10, 2, 23)), ends_at: new Date(2026, 10, 3, 1).toISOString() };
  const { firstHour, lastHour } = visibleHours(closed, [new Date(2026, 10, 2)], [lateNight]);
  assert.equal(lastHour <= 23, true);
  assert.equal(firstHour < lastHour, true);
});

test('visible hours look only at the part of a reservation inside the shown day', () => {
  const hours = normalizeBusinessHours([]);
  const overnight = { ...reservation('n', new Date(2026, 10, 2, 22)), ends_at: new Date(2026, 10, 3, 2).toISOString() };
  // 翌日は前の日から続いているので 0 時から出す
  assert.deepEqual(visibleHours(hours, [new Date(2026, 10, 3)], [overnight]), { firstHour: 0, lastHour: 19 });
  // 当日は 22 時から 24 時まで。カレンダーの最後の行は 23 時
  assert.deepEqual(visibleHours(hours, [new Date(2026, 10, 2)], [overnight]), { firstHour: 10, lastHour: 23 });
  // 表示する日と重ならない予約は幅に影響しない
  assert.deepEqual(visibleHours(hours, [new Date(2026, 10, 5)], [overnight]), { firstHour: 10, lastHour: 19 });
  // ちょうど 0 時に終わる予約は翌日に出ない
  const untilMidnight = { ...reservation('m', new Date(2026, 10, 2, 22)), ends_at: new Date(2026, 10, 3).toISOString() };
  assert.deepEqual(visibleHours(hours, [new Date(2026, 10, 3)], [untilMidnight]), { firstHour: 10, lastHour: 19 });
});

test('empty clock values fall back to the defaults', () => {
  const [sunday] = normalizeBusinessHours([{ day: 0, closed: true, open: '', close: '' }]);
  assert.deepEqual(sunday, { day: 0, closed: true, open: '10:00', close: '19:00' });
});

test('a day change never saves an empty clock and keeps the other days', () => {
  const saved = [{ day: 3, closed: false, open: '11:00', close: '20:00' }, { day: 1, closed: true, open: '09:00', close: '18:00' }];
  const merged = applyDayHours(saved, 3, { closed: true, open: null, close: null });
  assert.equal(merged.length, 7);
  assert.deepEqual(merged[3], { day: 3, closed: true, open: '11:00', close: '20:00' });
  assert.deepEqual(merged[1], { day: 1, closed: true, open: '09:00', close: '18:00' });
  assert.deepEqual(applyDayHours([], 3, { closed: true, open: null, close: null })[3], {
    day: 3,
    closed: true,
    open: '10:00',
    close: '19:00',
  });
  assert.deepEqual(applyDayHours(saved, 3, { closed: false, open: '12:00', close: '' })[3], {
    day: 3,
    closed: false,
    open: '12:00',
    close: '20:00',
  });
});

test('arrival can be recorded only for confirmed reservations of the day', () => {
  const now = new Date(2026, 10, 2, 13);
  assert.equal(canRecordArrival(reservation('today', new Date(2026, 10, 2, 14)), now), true);
  assert.equal(canRecordArrival(reservation('later', new Date(2026, 10, 9, 14)), now), false);
  assert.equal(canRecordArrival(reservation('past', new Date(2026, 10, 1, 14)), now), false);
  assert.equal(canRecordArrival(reservation('p', new Date(2026, 10, 2, 14), 'pending'), now), false);
  assert.equal(
    canRecordArrival(reservation('a', new Date(2026, 10, 2, 14), 'confirmed', { arrived_at: now.toISOString() }), now),
    false,
  );
});

test('a reservation from midnight to midnight is not treated as all day', () => {
  const start = new Date(2026, 10, 2);
  const end = new Date(2026, 10, 3);
  assert.equal(calendarEnd(start, end).getTime(), end.getTime() - 60_000);
  const usual = new Date(2026, 10, 2, 15);
  assert.equal(calendarEnd(new Date(2026, 10, 2, 14), usual), usual);
  assert.equal(calendarEnd(start, usual), usual);
});

test('the end label shows when it falls on the next day', () => {
  assert.equal(endClockLabel(15 * 60 + 30), '15:30');
  assert.equal(endClockLabel(24 * 60), '翌 0:00');
  assert.equal(endClockLabel(24 * 60 + 30), '翌 0:30');
});

test('pages never repeat a row', () => {
  const merged = appendUnique([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
  assert.deepEqual(merged.map((row) => row.id), ['a', 'b', 'c']);
});

test('reservations are split into one segment per visible day', () => {
  const start = new Date(2026, 10, 2, 22);
  const end = new Date(2026, 10, 6, 2);
  const range = { from: new Date(2026, 10, 1), to: new Date(2026, 10, 8) };
  const segments = dailySegments(start, end, range);
  assert.equal(segments.length, 5);
  assert.deepEqual(segments[0], { start, end: new Date(2026, 10, 2, 23, 59) });
  // 中日は 1 日分で、終日として隠されない
  assert.deepEqual(segments[1], { start: new Date(2026, 10, 3), end: new Date(2026, 10, 3, 23, 59) });
  assert.deepEqual(segments[4], { start: new Date(2026, 10, 6), end });
});

test('segments stay inside the visible range and leave a same-day reservation alone', () => {
  const start = new Date(2026, 10, 2, 22);
  const end = new Date(2026, 10, 30, 2);
  const range = { from: new Date(2026, 10, 8), to: new Date(2026, 10, 9) };
  assert.deepEqual(dailySegments(start, end, range), [{ start: range.from, end: new Date(2026, 10, 8, 23, 59) }]);
  const sameDay = { start: new Date(2026, 10, 8, 10), end: new Date(2026, 10, 8, 11) };
  assert.deepEqual(dailySegments(sameDay.start, sameDay.end, range), [sameDay]);
  assert.deepEqual(dailySegments(new Date(2026, 10, 9, 10), new Date(2026, 10, 9, 11), range), []);
});

test('a fully covered day and a reservation ending at midnight do not create an empty day', () => {
  const range = { from: new Date(2026, 10, 1), to: new Date(2026, 10, 8) };
  assert.deepEqual(dailySegments(new Date(2026, 10, 2), new Date(2026, 10, 3), range), [
    { start: new Date(2026, 10, 2), end: new Date(2026, 10, 2, 23, 59) },
  ]);
});

test('idempotency keys look like uuids and differ', () => {
  const key = newIdempotencyKey();
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(key, newIdempotencyKey());
});

test('the keyset filter selects rows after the cursor, breaking ties by id', () => {
  assert.equal(
    keysetFilter('created_at', { at: '2026-11-02T09:00:00.123+00:00', id: 'abc' }),
    'created_at.lt."2026-11-02T09:00:00.123+00:00",and(created_at.eq."2026-11-02T09:00:00.123+00:00",id.lt.abc)',
  );
});
