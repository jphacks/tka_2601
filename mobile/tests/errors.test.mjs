import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Cancelled, errorMessage, hasErrorCode } from '../src/lib/errors.ts';

test('only explicit authentication cancellation suppresses the message', () => {
  assert.equal(errorMessage(new Cancelled()), null);
  assert.equal(errorMessage(new Error('cancelled')), 'cancelled');
  assert.equal(errorMessage({ code: 'ERR_REQUEST_CANCELED' }), '[object Object]');
});

test('known authentication and network messages retain their translations', () => {
  const cases = [
    ['Invalid login credentials', 'メールアドレスかパスワードが違います。'],
    ['Email not confirmed', 'メールアドレスの確認が済んでいません。'],
    ['User already registered', 'このメールアドレスはすでに登録されています。'],
    ['Password should be at least 6 characters', 'パスワードが短すぎます。'],
    ['Unable to validate email address', 'メールアドレスの形が正しくありません。'],
    ['Invalid email', 'メールアドレスの形が正しくありません。'],
    ['Network request failed', 'ネットワークにつながりません。'],
    ['fetch failed', 'ネットワークにつながりません。'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(errorMessage(new Error(message)), expected);
    assert.equal(errorMessage({ message }), expected);
  }
});

test('matching preserves priority, case insensitivity, and repeated calls', () => {
  const message = 'FETCH FAILED: INVALID LOGIN CREDENTIALS';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(errorMessage(message), 'メールアドレスかパスワードが違います。');
  }
});

test('unrecognized response messages remain available to the caller', () => {
  assert.equal(errorMessage(new Error('permission denied')), 'permission denied');
  assert.equal(errorMessage({ message: 'invite expired', code: 'P0001' }), 'invite expired');
  assert.equal(errorMessage({ message: '' }), '');
  assert.equal(errorMessage({ message: 403 }), '403');
  assert.equal(errorMessage({ message: null }), 'null');
  assert.equal(errorMessage({ message: undefined }), 'undefined');
});

test('non-error rejection values can be formatted without property access failures', () => {
  for (const value of [null, undefined, true, 42, 'offline', Symbol('failure'), {}]) {
    assert.equal(errorMessage(value), String(value));
  }
});

test('native cancellation codes are checked without assuming the rejection shape', () => {
  const code = 'ERR_REQUEST_CANCELED';
  assert.equal(hasErrorCode({ code }, code), true);
  assert.equal(hasErrorCode(Object.assign(new Error(), { code }), code), true);
  assert.equal(hasErrorCode(Object.assign(() => undefined, { code }), code), true);
  for (const error of [null, undefined, code, 42, {}, { code: 'ERR_REQUEST_FAILED' }, { code: 1 }]) {
    assert.equal(hasErrorCode(error, code), false);
  }
});
