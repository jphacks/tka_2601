import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHIME_FAILURE_MESSAGES,
  CHIME_TIMEOUT_MESSAGE,
  chimeFailureMessage,
  chimeRegistrationLabel,
  chimeRunView,
  chimeStartView,
  chimeStep,
  HEARTBEAT_FRESH_MS,
  isHeartbeatFresh,
  isTerminalChimeView,
  LISTEN_TIMEOUT_MS,
  needsCancel,
  needsOnboarding,
  onboardingSkipKey,
  PICKUP_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  trackProgress,
} from '../src/domain/chime.ts';
import { toChimeEnrollment } from '../src/infrastructure/supabase/mappers.ts';

const T0 = 1_000_000;

function row(overrides = {}) {
  return {
    request_seq: 3,
    action: 'start',
    requested_at: '2026-11-09T00:00:00Z',
    handled_seq: 3,
    phase: 'noise',
    reason: null,
    registered: false,
    reported_at: '2026-11-09T00:00:01Z',
    ...overrides,
  };
}

function run(state, overrides = {}) {
  return { requestSeq: 3, requestedAt: T0, lastReadAt: T0, state, progress: null, ...overrides };
}

test('the heartbeat is fresh within three minutes and never when absent or malformed', () => {
  const now = Date.parse('2026-11-09T01:00:00Z');
  assert.equal(isHeartbeatFresh(null, now), false);
  assert.equal(isHeartbeatFresh('not a date', now), false);
  assert.equal(isHeartbeatFresh(new Date(now - HEARTBEAT_FRESH_MS).toISOString(), now), true);
  assert.equal(isHeartbeatFresh(new Date(now - HEARTBEAT_FRESH_MS - 1000).toISOString(), now), false);
  assert.equal(isHeartbeatFresh(new Date(now + 60_000).toISOString(), now), true);
  assert.deepEqual(chimeStartView(true), { kind: 'requesting' });
  assert.deepEqual(chimeStartView(false), { kind: 'waiting_device' });
});

test('a phase counts only once the device handled this very request', () => {
  // 前の依頼の done が残っていても、本体が今の依頼を拾うまでは進捗として読まない
  const stale = row({ request_seq: 3, handled_seq: 2, phase: 'done', registered: true });
  assert.deepEqual(chimeRunView(run(stale), T0 + 1000), { kind: 'requesting' });
  assert.deepEqual(chimeRunView(run(null), T0 + 1000), { kind: 'requesting' });
  assert.deepEqual(chimeRunView(run(row({ phase: 'noise' })), T0 + 1000), { kind: 'quiet' });
});

test('each phase of the current request maps to a view', () => {
  const view = (state) => chimeRunView(run(state), T0 + 1000);
  assert.deepEqual(view(row({ phase: 'idle' })), { kind: 'requesting' });
  assert.deepEqual(view(row({ phase: 'noise' })), { kind: 'quiet' });
  assert.deepEqual(view(row({ phase: 'listen' })), { kind: 'listen' });
  assert.deepEqual(view(row({ phase: 'analyze' })), { kind: 'checking' });
  assert.deepEqual(view(row({ phase: 'saving' })), { kind: 'checking' });
  assert.deepEqual(view(row({ phase: 'done', registered: true })), { kind: 'done' });
  assert.deepEqual(view(row({ phase: 'failed', reason: 'too_noisy' })), { kind: 'failed', reason: 'too_noisy' });
  assert.deepEqual(view(row({ phase: 'failed', reason: null })), { kind: 'failed', reason: 'no_recording' });
  assert.deepEqual(view(row({ phase: 'cancelled' })), { kind: 'failed', reason: 'cancelled' });
});

test('a request the device does not pick up within 20 seconds times out', () => {
  const state = row({ handled_seq: 2, phase: 'idle' });
  assert.deepEqual(chimeRunView(run(state, { lastReadAt: T0 + PICKUP_TIMEOUT_MS }), T0 + PICKUP_TIMEOUT_MS), { kind: 'requesting' });
  assert.deepEqual(
    chimeRunView(run(state, { lastReadAt: T0 + PICKUP_TIMEOUT_MS + 1 }), T0 + PICKUP_TIMEOUT_MS + 1),
    { kind: 'timeout' },
  );
});

test('progress that cannot be read for 20 seconds times out even mid-run', () => {
  const state = row({ phase: 'listen' });
  assert.deepEqual(chimeRunView(run(state, { lastReadAt: T0 }), T0 + PICKUP_TIMEOUT_MS + 1), { kind: 'timeout' });
});

test('listening for more than 60 seconds ends the attempt', () => {
  const listening = row({ phase: 'listen' });
  let progress = trackProgress(null, row({ phase: 'noise' }), T0);
  progress = trackProgress(progress, listening, T0 + 2000);
  const at = (now) => chimeRunView(run(listening, { progress, lastReadAt: now }), now);
  assert.deepEqual(at(T0 + 2000 + LISTEN_TIMEOUT_MS), { kind: 'listen' });
  assert.deepEqual(at(T0 + 2000 + LISTEN_TIMEOUT_MS + 1), { kind: 'failed', reason: 'listen_timeout' });
  // 同じ phase の再報告（reported_at だけ進む）では、待ち始めの時刻を動かさない
  const again = trackProgress(progress, row({ phase: 'listen', reported_at: '2026-11-09T00:00:30Z' }), T0 + 30_000);
  assert.equal(again.phaseSince, progress.phaseSince);
  assert.equal(again.changedAt, T0 + 30_000);
});

test('a stalled noise, analyze or saving phase times out after 30 seconds without a report', () => {
  for (const phase of ['noise', 'analyze', 'saving', 'idle']) {
    const state = row({ phase });
    const progress = trackProgress(null, state, T0);
    const at = (now) => chimeRunView(run(state, { progress, lastReadAt: now }), now);
    assert.notEqual(at(T0 + STALL_TIMEOUT_MS).kind, 'timeout', phase);
    assert.deepEqual(at(T0 + STALL_TIMEOUT_MS + 1), { kind: 'timeout' }, phase);
  }
  // 報告が進めば、同じ phase でも止まっていない
  const state = row({ phase: 'analyze' });
  let progress = trackProgress(null, state, T0);
  progress = trackProgress(progress, row({ phase: 'analyze', reported_at: '2026-11-09T00:00:25Z' }), T0 + 25_000);
  assert.deepEqual(chimeRunView(run(state, { progress, lastReadAt: T0 + 40_000 }), T0 + 40_000), { kind: 'checking' });
});

test('progress is not tracked without a row, and a new request restarts the clocks', () => {
  assert.equal(trackProgress(null, null, T0), null);
  const first = trackProgress(null, row({ phase: 'failed', reason: 'too_noisy' }), T0);
  const next = trackProgress(first, row({ handled_seq: 4, request_seq: 4, phase: 'failed', reason: 'too_noisy' }), T0 + 5000);
  assert.equal(next.phaseSince, T0 + 5000);
});

test('a newer request from another resident is followed instead of ending the screen early', () => {
  const state = row({ request_seq: 4, handled_seq: 3, phase: 'done', registered: true });
  assert.deepEqual(chimeRunView(run(state), T0 + 1000), { kind: 'requesting' });
});

test('every failure has a one-line message, and only unfinished attempts are cancelled', () => {
  for (const reason of ['too_noisy', 'too_short', 'clipped', 'no_recording', 'unstable', 'background_matches', 'busy', 'listen_timeout', 'cancelled']) {
    const message = CHIME_FAILURE_MESSAGES[reason];
    assert.ok(message && !message.includes('\n'), reason);
    assert.equal(chimeFailureMessage({ kind: 'failed', reason }), message);
  }
  assert.equal(CHIME_FAILURE_MESSAGES.too_noisy, '周りがうるさい');
  assert.equal(CHIME_FAILURE_MESSAGES.busy, '本体が通話中で登録できない');
  assert.equal(chimeFailureMessage({ kind: 'timeout' }), CHIME_TIMEOUT_MESSAGE);
  assert.equal(chimeFailureMessage({ kind: 'quiet' }), null);
  assert.equal(needsCancel({ kind: 'timeout' }), true);
  assert.equal(needsCancel({ kind: 'failed', reason: 'listen_timeout' }), true);
  assert.equal(needsCancel({ kind: 'failed', reason: 'too_noisy' }), false);
  assert.equal(needsCancel({ kind: 'done' }), false);
  for (const kind of ['done', 'timeout']) assert.equal(isTerminalChimeView({ kind }), true);
  assert.equal(isTerminalChimeView({ kind: 'failed', reason: 'busy' }), true);
  for (const kind of ['waiting_device', 'requesting', 'quiet', 'listen', 'checking']) {
    assert.equal(isTerminalChimeView({ kind }), false, kind);
  }
});

test('the three dots follow quiet, ring and check', () => {
  assert.equal(chimeStep({ kind: 'requesting' }), 1);
  assert.equal(chimeStep({ kind: 'quiet' }), 1);
  assert.equal(chimeStep({ kind: 'listen' }), 2);
  assert.equal(chimeStep({ kind: 'checking' }), 3);
  assert.equal(chimeStep({ kind: 'waiting_device' }), null);
  assert.equal(chimeStep({ kind: 'done' }), null);
});

test('the settings row says registered, unregistered or unknown', () => {
  assert.equal(chimeRegistrationLabel(toChimeEnrollment(row({ registered: true }))), '登録済み');
  assert.equal(chimeRegistrationLabel(toChimeEnrollment(row({ registered: false }))), '未登録');
  assert.equal(chimeRegistrationLabel(null), '未登録');
  assert.equal(chimeRegistrationLabel('unknown'), '状態不明');
});

test('only a household without a device that did not skip is sent to the onboarding', () => {
  const base = { settled: true, failed: false, hasDevice: false, skipped: false };
  assert.equal(needsOnboarding(base), true);
  assert.equal(needsOnboarding({ ...base, settled: false }), false);
  assert.equal(needsOnboarding({ ...base, failed: true }), false);
  assert.equal(needsOnboarding({ ...base, hasDevice: true }), false);
  assert.equal(needsOnboarding({ ...base, skipped: true }), false);
  assert.notEqual(onboardingSkipKey('a'), onboardingSkipKey('b'));
});

test('the row mapper rounds unknown values and accepts bigint strings', () => {
  const state = toChimeEnrollment(row({ request_seq: '7', handled_seq: 7, phase: 'future', reason: 'new_reason', action: 'pause' }));
  assert.equal(state.request_seq, 7);
  assert.equal(state.phase, 'idle');
  assert.equal(state.reason, null);
  assert.equal(state.action, null);
  const empty = toChimeEnrollment({});
  assert.deepEqual([empty.request_seq, empty.handled_seq, empty.phase, empty.registered], [0, 0, 'idle', false]);
  assert.equal(toChimeEnrollment(row({ phase: 'failed', reason: 'unstable' })).reason, 'unstable');
});
