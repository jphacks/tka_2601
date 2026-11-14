import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  pusherCapabilities,
  pusherConfig,
  pusherSyncState,
  readPusherConfig,
  readPusherSettings,
  samePusherConfig,
} from '../src/domain/pusher.ts';

const capabilities = { schema_versions: [1], pushers: [{ id: 'p1', gpio: 7 }, { id: 'p2', gpio: 8 }] };
const shared = pusherConfig(1, 'p1');
const separate = pusherConfig(2, 'p1');

function settings(overrides = {}) {
  return {
    desired_revision: 3,
    desired_config: shared,
    applied_revision: 3,
    applied_config: shared,
    applied_at: '2026-11-04T00:00:00Z',
    reported_at: '2026-11-04T00:01:00Z',
    apply_error: null,
    runtime_status: 'normal',
    capabilities,
    ...overrides,
  };
}

test('one pusher can serve both actions on either physical output', () => {
  for (const id of ['p1', 'p2']) {
    const config = pusherConfig(1, id);
    assert.deepEqual(config.enabled_pushers, [id]);
    assert.deepEqual(config.assignments, { call_start: id, call_end: id });
    assert.deepEqual(readPusherConfig(config), config);
  }
});

test('two pushers always receive different roles and can be swapped', () => {
  for (const id of ['p1', 'p2']) {
    const config = pusherConfig(2, id);
    assert.deepEqual(config.enabled_pushers, ['p1', 'p2']);
    assert.equal(config.assignments.call_start, id);
    assert.notEqual(config.assignments.call_start, config.assignments.call_end);
    assert.deepEqual(readPusherConfig(config), config);
  }
});

test('rejects absent, duplicate, unsupported and inconsistent assignments', () => {
  for (const value of [
    null, {}, [],
    { ...shared, schema_version: 2 },
    { ...shared, enabled_pushers: [] },
    { ...shared, enabled_pushers: ['p1', 'p1'] },
    { ...shared, enabled_pushers: ['p1', 'p2'] },
    { ...shared, assignments: { call_start: 'p1', call_end: 'p2' } },
    { ...shared, assignments: { call_start: 'p1' } },
    { ...shared, assignments: { call_start: 'p3', call_end: 'p3' }, enabled_pushers: ['p3'] },
    { ...separate, assignments: { call_start: 'p2', call_end: 'p2' } },
  ]) assert.throws(() => readPusherConfig(value), `accepted invalid config: ${JSON.stringify(value)}`);
});

test('physical output order is normalized without changing roles', () => {
  const reversed = { ...separate, enabled_pushers: ['p2', 'p1'] };
  assert.deepEqual(readPusherConfig(reversed), separate);
  assert.ok(samePusherConfig(reversed, separate));
  assert.ok(!samePusherConfig(pusherConfig(2, 'p2'), separate));
  assert.ok(!samePusherConfig(shared, separate));
});

test('unknown capability data does not claim unsupported firmware', () => {
  for (const value of [null, {}, { schema_versions: '1', pushers: [] }, { schema_versions: [1], pushers: [{ id: 'p3', gpio: 9 }] }]) {
    assert.equal(pusherCapabilities(value), null);
  }
  assert.equal(pusherSyncState(null), 'unknown');
  assert.equal(pusherSyncState(settings({ desired_config: null, applied_config: null, capabilities: null })), 'unknown');
  assert.equal(pusherSyncState(settings({ capabilities: null, applied_revision: null })), 'pending');
  assert.equal(pusherSyncState(settings({ capabilities: { schema_versions: [], pushers: [] } })), 'unsupported');
});

test('only a matching version and configuration with an application timestamp counts as applied', () => {
  assert.equal(pusherSyncState(settings()), 'applied');
  assert.equal(pusherSyncState(settings({ applied_revision: 2 })), 'pending');
  assert.equal(pusherSyncState(settings({ applied_config: pusherConfig(1, 'p2') })), 'pending');
  assert.equal(pusherSyncState(settings({ applied_at: null })), 'pending');
  assert.equal(pusherSyncState(settings({ applied_revision: null, reported_at: '2026-11-04T01:00:00Z' })), 'pending');
});

test('application failure and manual recovery take precedence over an older success', () => {
  assert.equal(pusherSyncState(settings({ apply_error: 'save_failed' })), 'failed');
  assert.equal(pusherSyncState(settings({ runtime_status: 'manual_check_required' })), 'manual_check_required');
  assert.equal(pusherSyncState(settings({ apply_error: 'save_failed', runtime_status: 'manual_check_required' })), 'manual_check_required');
  assert.equal(pusherSyncState(settings({ applied_revision: 2, apply_error: 'busy' })), 'pending');
});

test('local setup remains a local setup until the user explicitly saves a desired configuration', () => {
  assert.equal(pusherSyncState(settings({ desired_revision: 0, desired_config: null })), 'local');
  const initial = readPusherSettings(settings({ desired_revision: 0, desired_config: null }));
  assert.equal(initial.desired_config, null);
  assert.deepEqual(initial.applied_config, shared);
});

test('refuses corrupt version and configuration data from the API', () => {
  for (const value of [
    {}, settings({ desired_revision: -1 }), settings({ desired_revision: 1.5 }),
    settings({ applied_revision: '3' }), settings({ applied_revision: -1 }),
    settings({ desired_config: { ...shared, schema_version: 2 } }), settings({ reported_at: true }),
  ]) assert.throws(() => readPusherSettings(value));
  assert.deepEqual(readPusherSettings(settings()), settings());
});
