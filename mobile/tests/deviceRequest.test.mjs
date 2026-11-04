import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceRequest } from '../src/infrastructure/supabase/deviceRequest.ts';

test('a response deadline releases the caller and aborts its request', async () => {
  let signal;
  await assert.rejects(deviceRequest((value) => { signal = value; return new Promise(() => {}); }, 5), /応答/);
  assert.equal(signal.aborted, true);
});

test('successful and failed requests retain their result before the deadline', async () => {
  assert.equal(await deviceRequest(() => Promise.resolve('actual-result')), 'actual-result');
  const failure = new Error('connection lost');
  await assert.rejects(deviceRequest(() => Promise.reject(failure)), (error) => error === failure);
});
