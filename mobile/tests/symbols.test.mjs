import assert from 'node:assert/strict';
import { test } from 'node:test';

import { intentSymbol, MODE_SYMBOLS, notificationSymbol, SYMBOLS } from '../src/lib/symbols.ts';

test('来客の意図ごとのアイコン。意図がなければ不明にする', () => {
  assert.equal(intentSymbol('delivery').ios, 'shippingbox');
  assert.equal(intentSymbol('emergency').ios, 'exclamationmark.triangle');
  assert.equal(intentSymbol(null), SYMBOLS.unknown);
});

test('通知の種類ごとのアイコン。知らない種類はベルにする', () => {
  const expected = {
    chime: 'person.2',
    ended: 'bubble.left',
    reservation_pending: 'clock',
    reservation_created: 'calendar.badge.plus',
    reservation_updated: 'calendar',
    reservation_cancelled: 'calendar.badge.minus',
    reservation_arrived: 'checkmark.circle',
    device_offline: 'wifi.slash',
    calendar_sync_failed: 'exclamationmark.triangle',
  };
  for (const [kind, name] of Object.entries(expected)) assert.equal(notificationSymbol(kind).ios, name, kind);
  assert.equal(notificationSymbol('new_kind'), SYMBOLS.bell);
});

test('本体とチャイムの登録の画面のアイコン', () => {
  assert.deepEqual(
    [SYMBOLS.device.ios, SYMBOLS.wifi.ios, SYMBOLS.microphone.ios, SYMBOLS.bell.ios, SYMBOLS.waveform.ios, SYMBOLS.alert.ios],
    ['hifispeaker', 'wifi', 'mic', 'bell', 'waveform', 'exclamationmark.circle'],
  );
  for (const key of ['device', 'wifi', 'microphone', 'waveform', 'alert']) assert.ok(SYMBOLS[key].android, key);
});

test('動作モードのアイコン', () => {
  assert.deepEqual(
    [MODE_SYMBOLS.normal.ios, MODE_SYMBOLS.omakase.ios, MODE_SYMBOLS.away.ios, MODE_SYMBOLS.off.ios],
    ['person', 'sparkles', 'figure.walk', 'pause.circle'],
  );
});
