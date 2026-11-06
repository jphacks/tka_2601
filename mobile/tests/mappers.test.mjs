import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  toAssistantProposal,
  toDevice,
  toNotification,
  toProviderState,
  toReceptionCalendar,
  toReceptionEvent,
  toReceptionGoogle,
  toReceptionVisit,
  toReservation,
  toShopProfile,
  toVisit,
  toVisitMessage,
} from '../src/infrastructure/supabase/mappers.ts';

test('unknown visit values from the voice agent are rounded without crashing', () => {
  const visit = toVisit({
    id: 'v',
    mode: 'future_mode',
    chimed_at: '2026-11-02T10:00:00Z',
    status: 'on_hold',
    intent: 'reservation_inquiry',
    outcome: 'booked',
    end_reason: 'new_reason',
  });
  assert.equal(visit.mode, 'normal');
  assert.equal(visit.status, 'ended');
  assert.equal(visit.intent, 'unknown');
  assert.equal(visit.outcome, 'none');
  assert.equal(visit.end_reason, null);
});

test('known visit values pass through and null stays null', () => {
  const visit = toVisit({ id: 'v', mode: 'away', status: 'in_call', intent: 'sales', outcome: null, end_reason: 'closing' });
  assert.equal(visit.mode, 'away');
  assert.equal(visit.status, 'in_call');
  assert.equal(visit.intent, 'sales');
  assert.equal(visit.outcome, null);
  assert.equal(visit.end_reason, 'closing');
});

test('unknown speakers still render as a message', () => {
  assert.equal(toVisitMessage({ speaker: 'operator', text: 'x', seq: 1 }).speaker, 'ai');
});

test('reservation fills defaults for unknown and missing values', () => {
  const reservation = toReservation({ id: 'r', status: 'waitlist', source: 'phone', customer_name: '田中' });
  assert.equal(reservation.status, 'pending');
  assert.equal(reservation.source, 'external');
  assert.equal(reservation.read_only, false);
  assert.equal(reservation.customer_phone, null);
  assert.equal(toReservation({ read_only: true }).read_only, true);
});

test('provider state survives missing sections and unknown providers', () => {
  const state = toProviderState({ provider: 'stores' });
  assert.equal(state.provider, 'monban');
  assert.equal(state.capabilities.create, true);
  assert.equal(state.google.connected, false);
  assert.equal(state.square.status, null);
  assert.equal(toProviderState({ capabilities: { create: false } }).capabilities.create, false);
});

test('shop profile rounds unknown settings and drops broken hours', () => {
  const profile = toShopProfile({
    business_type: 'gym',
    tone: 'rude',
    walk_in_policy: 'maybe',
    reservation_provider: 'hotpepper',
    business_hours: [{ day: 1, closed: true }, { closed: true }, 'x'],
  });
  assert.equal(profile.business_type, 'other');
  assert.equal(profile.tone, 'very_polite');
  assert.equal(profile.walk_in_policy, 'take_reservation');
  assert.equal(profile.reservation_provider, 'hotpepper');
  assert.deepEqual(profile.business_hours, [{ day: 1, closed: true, open: '10:00', close: '19:00' }]);
});

test('notification data falls back to an empty object', () => {
  assert.deepEqual(toNotification({ id: 'n', data: null }).data, {});
});

test('assistant proposals keep valid shapes', () => {
  const add = toAssistantProposal({
    type: 'add_reservation',
    customer_name: '田中',
    starts_at: '2026-11-05T05:00:00Z',
    ends_at: '2026-11-05T06:30:00Z',
    service_name: 'ジェルネイル',
    warnings: ['重なります', 1],
  });
  assert.equal(add.type, 'add_reservation');
  assert.deepEqual(add.warnings, ['重なります']);
  assert.equal(add.customer_phone, null);

  const update = toAssistantProposal({
    type: 'update_reservation',
    reservation_id: 'r',
    customer_name: '田中',
    before: { starts_at: 'a', ends_at: 'b' },
    after: { starts_at: 'c', ends_at: 'd' },
    warnings: [],
  });
  assert.equal(update.type, 'update_reservation');

  const hours = toAssistantProposal({
    type: 'set_business_hours',
    day: 3,
    before: { closed: false, open: '10:00', close: '19:00' },
    after: { closed: true, open: '10:00', close: '19:00' },
  });
  assert.equal(hours.type, 'set_business_hours');
  assert.equal(hours.after.closed, true);

  // 営業時間が未設定の曜日は null のまま渡し、空文字にしない
  const unset = toAssistantProposal({
    type: 'set_business_hours',
    day: 3,
    before: { closed: false, open: null, close: null },
    after: { closed: true, open: null, close: null },
  });
  assert.deepEqual(unset.before, { closed: false, open: null, close: null });
  assert.deepEqual(unset.after, { closed: true, open: null, close: null });
});

test('broken assistant proposals never reach the write path', () => {
  for (const broken of [
    null,
    'text',
    { type: 'delete_everything' },
    { type: 'add_reservation', customer_name: '田中' },
    { type: 'add_reservation', customer_name: '', starts_at: 'a', ends_at: 'b' },
    { type: 'update_reservation', before: {}, after: {} },
    { type: 'set_business_hours', day: 9, before: {}, after: {} },
  ]) {
    assert.equal(toAssistantProposal(broken).type, 'unknown');
  }
  assert.equal(toAssistantProposal({ type: 'unknown', reason: '理由' }).reason, '理由');
});

test('reception rows from the door backend tolerate missing and wrongly typed fields', () => {
  assert.deepEqual(toReceptionVisit({ created: '2026-11-04T01:00:00Z', status: 'ended', name: '山田', staff: '佐藤' }), {
    created: '2026-11-04T01:00:00Z',
    status: 'ended',
    name: '山田',
    staff: '佐藤',
    staff_notified: false,
    notification_reason: '',
  });
  assert.equal(toReceptionVisit({ staff_notified: 'true' }).staff_notified, false);
  assert.deepEqual(toReceptionGoogle({ configured: true, calendar_id: 7 }), { configured: true, calendar_id: '' });
  assert.deepEqual(toReceptionCalendar({ id: 'a@example.com' }), { id: 'a@example.com', summary: '' });
  assert.deepEqual(toReceptionEvent({ start: null, eligible: false, name: '休憩' }), { start: null, eligible: false, name: '休憩' });
  assert.equal(toReceptionEvent({ eligible: 1 }).eligible, false);
});

const deviceRow = {
  id: 'd1',
  household_id: 'h1',
  name: '玄関',
  mode: 'away',
  applied_mode: 'off',
  applied_mode_at: '2026-11-06T01:02:03.456Z',
  last_heartbeat_at: '2026-11-06T01:05:00Z',
  away_leave_at_door: true,
  auto_away: false,
  extra_instructions: '置き配は不可',
};

test('device keeps the saved mode, the applied mode and the heartbeat time apart', () => {
  const device = toDevice(deviceRow);
  assert.equal(device.mode, 'away');
  assert.equal(device.applied_mode, 'off');
  assert.equal(device.applied_mode_at, '2026-11-06T01:02:03.456Z');
  assert.equal(device.last_heartbeat_at, '2026-11-06T01:05:00Z');
  assert.equal(device.away_leave_at_door, true);
  assert.equal(device.auto_away, false);
  assert.equal(device.extra_instructions, '置き配は不可');
  assert.equal(device.name, '玄関');
});

test('a device that never reported has null applied mode and times, not the saved mode', () => {
  for (const row of [
    { ...deviceRow, applied_mode: null, applied_mode_at: null, last_heartbeat_at: null },
    { ...deviceRow, applied_mode: undefined, applied_mode_at: undefined, last_heartbeat_at: undefined },
  ]) {
    const device = toDevice(row);
    assert.equal(device.mode, 'away');
    assert.equal(device.applied_mode, null);
    assert.equal(device.applied_mode_at, null);
    assert.equal(device.last_heartbeat_at, null);
  }
});

test('an unknown applied mode becomes unknown with no time, and an applied time without a mode is dropped', () => {
  const unknown = toDevice({ ...deviceRow, applied_mode: 'stop' });
  assert.equal(unknown.applied_mode, null);
  assert.equal(unknown.applied_mode_at, null);
  assert.equal(unknown.mode, 'away');
  const timeOnly = toDevice({ ...deviceRow, applied_mode: null });
  assert.equal(timeOnly.applied_mode, null);
  assert.equal(timeOnly.applied_mode_at, null);
  // 知らない保存モードは、他の変換と同じく通常に寄せるが、適用モードは混ぜない
  const future = toDevice({ ...deviceRow, mode: 'future_mode', applied_mode: 'omakase' });
  assert.equal(future.mode, 'normal');
  assert.equal(future.applied_mode, 'omakase');
});

test('every applied mode passes through unchanged', () => {
  for (const mode of ['normal', 'omakase', 'away', 'off']) {
    assert.equal(toDevice({ ...deviceRow, applied_mode: mode }).applied_mode, mode);
  }
});

test('device flags and text fall back safely', () => {
  const device = toDevice({ id: 'd1' });
  assert.equal(device.away_leave_at_door, false);
  assert.equal(device.auto_away, false);
  assert.equal(device.extra_instructions, '');
  assert.equal(device.name, null);
  assert.equal(device.last_heartbeat_at, null);
});
