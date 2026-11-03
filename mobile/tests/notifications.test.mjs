import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupNotificationKinds, isUnread, newestCreatedAt, notificationTarget } from '../src/domain/notification.ts';

test('notification targets prefer the reservation and ignore other values', () => {
  assert.deepEqual(notificationTarget({ reservation_id: 'r', visit_id: 'v' }), { type: 'reservation', id: 'r' });
  assert.deepEqual(notificationTarget({ visit_id: 'v' }), { type: 'visit', id: 'v' });
  assert.equal(notificationTarget({ device_id: 'd' }), null);
  assert.equal(notificationTarget({ reservation_id: 1 }), null);
  assert.deepEqual(notificationTarget({}, 'calendar_sync_failed'), { type: 'provider', id: '' });
  assert.equal(notificationTarget({}, 'device_offline'), null);
});

test('unread is judged by time, with offsets compared as instants', () => {
  assert.equal(isUnread('2026-11-02T10:00:00Z', null), true);
  assert.equal(isUnread('2026-11-02T10:00:01Z', '2026-11-02T10:00:00Z'), true);
  assert.equal(isUnread('2026-11-02T10:00:00Z', '2026-11-02T10:00:00Z'), false);
  assert.equal(isUnread('2026-11-02T19:00:00+09:00', '2026-11-02T10:00:00Z'), false);
});

test('the newest notification time is picked regardless of order', () => {
  assert.equal(newestCreatedAt([]), null);
  assert.equal(
    newestCreatedAt([{ created_at: '2026-11-01T00:00:00Z' }, { created_at: '2026-11-02T00:00:00Z' }]),
    '2026-11-02T00:00:00Z',
  );
});

test('kinds keep table order within categories and fall back to their default', () => {
  const kind = (name, category, defaultEnabled, sort) => ({
    kind: name,
    label: name,
    category,
    default_enabled: defaultEnabled,
    sort_order: sort,
  });
  const sections = groupNotificationKinds(
    [kind('chime', 'visit', true, 1), kind('created', 'reservation', true, 2), kind('ended', 'visit', false, 3), kind('new', 'future', true, 4)],
    [{ kind: 'chime', enabled: false }],
  );
  assert.deepEqual(sections.map((s) => s.category), ['visit', 'reservation', 'future']);
  assert.deepEqual(sections[0].kinds.map((k) => [k.kind, k.enabled]), [
    ['chime', false],
    ['ended', false],
  ]);
  assert.equal(sections[2].kinds[0].enabled, true);
});
