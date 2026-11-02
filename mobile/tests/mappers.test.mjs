import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  toAssistantProposal,
  toNotification,
  toProviderState,
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
