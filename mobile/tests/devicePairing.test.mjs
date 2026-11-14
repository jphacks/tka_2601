import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePairingCode, pairingFailureMessage } from '../src/domain/devicePairing.ts';

test('pairing accepts case and human-readable separators without changing code identity', () => {
  assert.equal(normalizePairingCode(' abcd-2345\n'), 'ABCD2345');
  assert.equal(normalizePairingCode('ABCD2345'), 'ABCD2345');
});

test('pairing rejects ambiguous characters, partial codes and unexpected punctuation', () => {
  for (const input of ['', 'ABCD234', 'ABCD23456', 'ABCD0123', 'ABCDI234', 'ABCDO234', 'ＡBCD2345', 'ABCD!2345']) {
    assert.equal(normalizePairingCode(input), null, input);
  }
});

test('claim errors distinguish consumed codes, memberships and already registered devices', () => {
  const messages = ['PT404', 'PT403', 'PT409', '23505'].map((code) => pairingFailureMessage({ code }));
  assert.equal(new Set(messages).size, 4);
  assert.match(messages[0], /使用/);
  assert.match(messages[1], /参加/);
  assert.match(messages[2], /このお店/);
  assert.match(messages[3], /別のお店/);
  for (const error of [null, undefined, new Error('fetch failed'), {}]) {
    assert.match(pairingFailureMessage(error), /登録結果.*確認/);
  }
});
