import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  calendarDayKey,
  customerLabel,
  datesInRange,
  dayRange,
  monthRange,
  monthWeekCount,
  nextReservation,
  reservationsByDay,
  reservationSections,
  weekRange,
} from '../src/domain/reservation.ts';
import { isClosedOn, normalizeBusinessHours, visibleHours } from '../src/domain/shop.ts';

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
