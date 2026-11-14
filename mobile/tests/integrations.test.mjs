import assert from 'node:assert/strict';
import { test } from 'node:test';

import { integrationStatus, isIntegration, oauthOutcome, visibleIntegrations } from '../src/lib/integrations.ts';

function state(provider, { google = false, square = false } = {}) {
  return {
    provider,
    capabilities: { create: true },
    google: { connected: google, account_email: null, calendar_id: null, calendar_name: null, status: null, last_error: null },
    square: { connected: square, merchant_name: null, status: null, last_error: null },
  };
}

test('integration names are checked before a screen is opened', () => {
  assert.equal(isIntegration('google_calendar'), true);
  assert.equal(isIntegration('hotpepper'), true);
  assert.equal(isIntegration('monban'), false);
  assert.equal(isIntegration(undefined), false);
});

test('the status shows what is in use first, then whether it is connected', () => {
  assert.equal(integrationStatus(state('google_calendar', { google: true }), 'google_calendar'), '使用中');
  assert.equal(integrationStatus(state('google_calendar', { google: true, square: true }), 'square'), '接続済み');
  assert.equal(integrationStatus(state('monban'), 'square'), '未接続');
  assert.equal(integrationStatus(state('monban'), 'hotpepper'), '未使用');
  assert.equal(integrationStatus(state('hotpepper'), 'hotpepper'), '使用中');
});

test('Calendar is visible and Hotpepper is hidden independently of the shared OAuth flag', () => {
  const flags = { googleCalendar: true, hotpepper: false, externalProviders: false };
  assert.deepEqual(visibleIntegrations(state('monban'), flags), ['google_calendar']);
  assert.deepEqual(visibleIntegrations(null, flags), ['google_calendar']);
  assert.deepEqual(visibleIntegrations(state('hotpepper'), flags), ['google_calendar']);
  assert.deepEqual(visibleIntegrations(state('square'), flags), ['google_calendar', 'square']);
  assert.deepEqual(visibleIntegrations(null, { ...flags, externalProviders: true }), ['google_calendar', 'square']);
  assert.deepEqual(visibleIntegrations(null, { ...flags, hotpepper: true }), ['google_calendar', 'hotpepper']);
  assert.deepEqual(visibleIntegrations(null, { ...flags, googleCalendar: false }), []);
});

test('the time of a staff check is shown relative to today', async () => {
  const { relativeDateTime } = await import('../src/lib/format.ts');
  const now = new Date(2026, 10, 4, 12, 0);
  assert.equal(relativeDateTime(new Date(2026, 10, 4, 10, 42).toISOString(), now), '今日 10:42');
  assert.equal(relativeDateTime(new Date(2026, 10, 3, 17, 3).toISOString(), now), '昨日 17:03');
  assert.equal(relativeDateTime(new Date(2026, 9, 30, 9, 5).toISOString(), now), '10月30日 9:05');
  assert.equal(relativeDateTime('not a date', now), 'not a date');
});

test('the query after the consent screen completes only with pending and a code', () => {
  assert.deepEqual(oauthOutcome({ google: 'pending', code: 'abc' }, 'google'), { kind: 'pending', code: 'abc' });
  assert.deepEqual(oauthOutcome({ square: 'pending', code: 'abc' }, 'square'), { kind: 'pending', code: 'abc' });
  assert.deepEqual(oauthOutcome({ google: 'error' }, 'google'), { kind: 'error' });
  // 取り消し、別の連携の結果、code がない、配列（同じ名前が2つ）は何もしない
  for (const query of [
    { google: 'cancelled' },
    { square: 'pending', code: 'abc' },
    { google: 'pending' },
    { google: 'pending', code: '' },
    { google: 'pending', code: ['a', 'b'] },
    {},
    null,
    undefined,
  ]) {
    assert.deepEqual(oauthOutcome(query, 'google'), { kind: 'none' }, JSON.stringify(query));
  }
});
