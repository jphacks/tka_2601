import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deviceStatusRow, relativeAgo } from '../src/lib/deviceStatus.ts';

const NOW = new Date('2026-11-06T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

test('相対時刻は、たった今、分、時間、日で出す', () => {
  assert.equal(relativeAgo(ago(30_000), NOW), 'たった今');
  assert.equal(relativeAgo(ago(MIN), NOW), '1分前');
  assert.equal(relativeAgo(ago(3 * MIN + 5_000), NOW), '3分前');
  assert.equal(relativeAgo(ago(59 * MIN), NOW), '59分前');
  assert.equal(relativeAgo(ago(60 * MIN), NOW), '1時間前');
  assert.equal(relativeAgo(ago(23 * 60 * MIN), NOW), '23時間前');
  assert.equal(relativeAgo(ago(48 * 60 * MIN), NOW), '2日前');
});

test('時計がずれて未来の時刻でも たった今 と出す', () => {
  assert.equal(relativeAgo(ago(-5 * MIN), NOW), 'たった今');
});

test('適用中のモードと最終通信を並べる', () => {
  const row = deviceStatusRow({ mode: 'omakase', applied_mode: 'omakase', last_heartbeat_at: ago(3 * MIN) }, NOW);
  assert.deepEqual(row, { applied: 'omakase', pending: false, communication: '最終通信 3分前', stale: false });
});

test('保存したモードと食い違えば 反映待ち', () => {
  const row = deviceStatusRow({ mode: 'away', applied_mode: 'normal', last_heartbeat_at: ago(MIN) }, NOW);
  assert.equal(row.applied, 'normal');
  assert.equal(row.pending, true);
});

test('最終通信が 15 分を過ぎたときだけ stale', () => {
  const at = (ms) => deviceStatusRow({ mode: 'normal', applied_mode: 'normal', last_heartbeat_at: ago(ms) }, NOW).stale;
  assert.equal(at(15 * MIN), false);
  assert.equal(at(15 * MIN + 1), true);
  assert.equal(at(2 * 60 * MIN), true);
});

test('一度も報告がなければ行を出さない', () => {
  assert.equal(deviceStatusRow({ mode: 'normal', applied_mode: null, last_heartbeat_at: null }, NOW), null);
});

test('片方だけ欠けるときは、あるほうを出して欠けたほうを短く示す', () => {
  const noMode = deviceStatusRow({ mode: 'normal', applied_mode: null, last_heartbeat_at: ago(MIN) }, NOW);
  assert.deepEqual(noMode, { applied: null, pending: false, communication: '最終通信 1分前', stale: false });
  const noHeartbeat = deviceStatusRow({ mode: 'off', applied_mode: 'off', last_heartbeat_at: null }, NOW);
  assert.deepEqual(noHeartbeat, { applied: 'off', pending: false, communication: '通信なし', stale: false });
});

test('読めない時刻は届いていないものとして扱う', () => {
  assert.equal(deviceStatusRow({ mode: 'normal', applied_mode: null, last_heartbeat_at: 'x' }, NOW), null);
});

test('反映待ちの取り直しは、最初の1分は5秒ごと、その後は15秒ごとで、約3分で止める', async () => {
  const { PENDING_REFRESH_LIMIT, pendingRefreshDelay } = await import('../src/lib/deviceStatus.ts');
  assert.equal(pendingRefreshDelay(0), 5_000);
  assert.equal(pendingRefreshDelay(11), 5_000);
  assert.equal(pendingRefreshDelay(12), 15_000);
  let total = 0;
  for (let attempt = 0; attempt < PENDING_REFRESH_LIMIT; attempt += 1) total += pendingRefreshDelay(attempt);
  // 本体は15秒ごとにモードを取りに来るので、何度か取り逃しても間に合う長さにする
  assert.ok(total >= 120_000 && total <= 240_000, `total=${total}`);
});
