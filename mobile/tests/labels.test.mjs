import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approveDialogTitle, PROVIDER_LABELS, PROVIDER_ORDER, sourceLabel } from '../src/lib/labels.ts';

test('予約先の順序は予約帳、Google、Square、ホットペッパー', () => {
  assert.deepEqual(PROVIDER_ORDER, ['monban', 'google_calendar', 'square', 'hotpepper']);
  assert.equal(PROVIDER_LABELS.square, 'Square 予約');
});

test('手で入力する予約先は、承認の確認で入力を尋ねる', () => {
  assert.equal(approveDialogTitle('hotpepper'), 'SALON BOARD に\n入力しましたか');
  assert.equal(approveDialogTitle('square'), 'Square に\n入力しましたか');
  assert.equal(approveDialogTitle('monban'), 'この予約を確定しますか');
  assert.equal(approveDialogTitle(null), 'この予約を確定しますか');
});

test('外部の予約の受付元は今の予約先で出す', () => {
  assert.equal(sourceLabel('external', 'square'), 'Square 予約');
  assert.equal(sourceLabel('external', 'google_calendar'), 'Google カレンダー');
  assert.equal(sourceLabel('ai', 'square'), 'AI（インターホン）');
});
