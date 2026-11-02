import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Run the page's real rules without a browser.
const source = readFileSync(new URL('../calibration_ui/logic.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const {ServoEditor, chimeProgress, callProgress, callCompleted, CALL_STEPS, errorText} = context.MonbanLogic;

const state = (overrides = {}) => ({active: false, motion_busy: false, test_busy: false, motion_error: '',
  call_rest: 180, call_press: 30, end_rest: 0, end_press: 30, unlock_rest: 0, unlock_press: 30,
  call_delay_ms: 3000, call_hold_ms: 300, end_hold_ms: 300, unlock_hold_ms: 300, return_ms: 1000, ...overrides});
function fixture(handler = () => ({ok: true})) {
  const requests = [];
  const api = async (action, body) => { requests.push({action, body}); return handler(action, body); };
  const editor = new ServoEditor(api, async () => {}, () => {});
  editor.apply(state());
  return {editor, requests};
}
const refused = code => { throw Object.assign(new Error(code), {code}); };

// A test press is never queued behind an edit or a moving servo.
for (const target of ['c', 'e', 'u']) {
  for (const prepare of [
    e => { e.motionBusy = true; },
    e => { e.testing = true; },
    e => { e.pumping = true; },
    e => { e.pending.set('cpress', {}); },
  ]) {
    const {editor, requests} = fixture();
    prepare(editor);
    assert.equal(await editor.test(target), false);
    assert.equal(requests.length, 0, 'preview must not queue a test press');
  }
  // A refused press is not replayed later.
  let attempts = 0;
  const {editor} = fixture(() => { attempts += 1; refused('receiver_busy'); });
  await editor.test(target);
  assert.equal(attempts, 1);
  assert.equal(editor.message, errorText('receiver_busy'));
  assert.equal(editor.requesting, false);
  // The accepted press goes out once, for that servo.
  const ok = fixture(() => state({test_busy: true}));
  assert.equal(await ok.editor.test(target), true);
  assert.deepEqual(ok.requests.map(r => r.action), ['test']);
  assert.equal(ok.requests[0].body.target, target);
  assert.equal(ok.editor.testing, true);
}
console.log('Web UI: no queued/retried test press behind a preview passed');

// Editing starts calibration once, sends only the newest value, and survives a busy servo.
{
  const {editor, requests} = fixture();
  editor.setAngleLocal('c', 'press', 40);
  assert.equal(editor.dirty, true);
  assert.equal(requests.length, 0, 'dragging alone must not move the servo');
  await editor.commitAngle('c', 'press');
  assert.deepEqual(requests.map(r => r.action), ['begin', 'preview']);
  assert.equal(requests[1].body.angle, 40);
  assert.equal(requests[1].body.position, 'p', 'server.py command_for accepts r or p');
  editor.setAngleLocal('c', 'rest', 170);
  await editor.commitAngle('c', 'rest');
  assert.equal(requests.at(-1).body.position, 'r');
  await editor.commitAngle('c', 'press');
  await editor.commitTiming('return_ms');
  assert.deepEqual(requests.map(r => r.action), ['begin', 'preview', 'preview', 'preview', 'timing']);
}
{
  let busy = 2;
  const {editor, requests} = fixture(action => {
    if (action === 'preview' && busy-- > 0) refused('servo_busy');
    return {ok: true};
  });
  editor.setAngleLocal('e', 'rest', 12);
  await editor.commitAngle('e', 'rest');
  assert.equal(requests.filter(r => r.action === 'preview').length, 3);
  assert.equal(editor.pending.size, 0);
  assert.equal(editor.message, '');
}
{
  const {editor} = fixture(action => { if (action === 'begin') refused('receiver_busy'); return {ok: true}; });
  editor.setAngleLocal('c', 'rest', 5);
  await editor.commitAngle('c', 'rest');
  assert.equal(editor.pending.size, 0);
  assert.equal(editor.message, errorText('receiver_busy'));
}
// Mirroring works for every servo and never moves it; refused while something runs.
{
  const {editor, requests} = fixture(() => state());
  await editor.mirror('u');
  assert.deepEqual(requests.map(r => r.action), ['begin', 'angles']);
  assert.deepEqual([requests[1].body.rest, requests[1].body.press], [180, 150]);
  assert.equal(editor.values.u.press, 150);
  editor.motionBusy = true;
  assert.equal(await editor.mirror('u'), false);
}
// Saving and undoing end the edit; the board's values come back.
{
  const {editor, requests} = fixture(action => action === 'save' ? state({call_press: 40}) : action === 'cancel' ? state() : {ok: true});
  editor.setAngleLocal('c', 'press', 40);
  await editor.save();
  assert.deepEqual(requests.map(r => r.action), ['begin', 'angles', 'save'], 'saving sends what is on screen without a press preview');
  assert.equal(editor.dirty, false);
  assert.equal(editor.values.c.press, 40);
  editor.setAngleLocal('c', 'press', 60);
  editor.active = true;
  await editor.undo();
  assert.equal(editor.dirty, false);
  assert.equal(editor.values.c.press, 30);
}
// A failed save keeps the edit visible.
{
  const {editor} = fixture(action => { if (action === 'save') refused('save_failed'); return {ok: true}; });
  editor.setAngleLocal('c', 'press', 40);
  assert.equal(await editor.save(), false);
  assert.equal(editor.dirty, true);
  assert.equal(editor.message, errorText('save_failed'));
}
// The board's 2 minute timeout discards the edit and says so.
{
  const {editor} = fixture();
  editor.setAngleLocal('c', 'press', 40);
  editor.active = true;
  editor.apply(state());
  assert.equal(editor.dirty, false);
  assert.equal(editor.values.c.press, 30);
  assert.ok(editor.message.includes('取り消しました'));
}
// Tapping save right after a timing change must not save the old value.
{
  const {editor, requests} = fixture(action => action === 'save' ? state() : {ok: true});
  editor.setTimingLocal('return_ms', 800);
  await editor.save();
  assert.equal(requests[1].action, 'timing');
  assert.equal(requests[1].body.value, 800);
}
console.log('Web UI: edit, preview retry, mirror, save, undo and timeout passed');

// Registration follows what the board actually reported.
const chime = (...lines) => chimeProgress(lines);
assert.equal(chime().step, -1);
assert.equal(chime('[SETUP] Keep quiet for 5 seconds. Measuring background noise.').step, 0);
assert.equal(chime('[SETUP] Ring the intercom once (1/3). Gate=80.').step, 1);
assert.equal(chime('[SETUP] Recorded. Ring once again (2/3).').step, 2);
assert.equal(chime('[SETUP] Recorded. Ring once again (3/3).').step, 3);
assert.equal(chime('[SETUP] Three recordings agree. Ring once more to verify.').step, 4);
assert.equal(chime('[SETUP] Verification passed. Saving registered features.').step, 5);
assert.equal(chime('[SETUP] Ring the intercom once (1/3). Gate=80.', '[SETUP] Registration cancelled; active model is unchanged.').step, -1);
assert.equal(chime('[SETUP] Ring the intercom once (1/3). Gate=80.', '[BOOT] Network task running.').step, -1);
const differ = chime('[SETUP] Recorded. Ring once again (3/3).', '[SETUP] Recordings differ too much. Enter e to start again.');
assert.equal(differ.step, -1);
assert.ok(differ.message.length > 0);
const retry = chime('[SETUP] Three recordings agree. Ring once more to verify.', '[SETUP] Verification did not match. Retry, or e to register again.');
assert.equal(retry.step, 4);
assert.ok(retry.message.length > 0);
assert.equal(chime('[SETUP] Keep quiet for 5 seconds.', '[SETUP] Too noisy; retry in a quieter setting.').step, -1);
assert.equal(chime('[SETUP] Ring the intercom once (1/3).', '[SETUP] Capture gap; registration cancelled.').step, -1);
assert.equal(chime('[AUDIO] Candidate too short or clipped; ignored.').message, '', 'ordinary sounds outside registration say nothing');
assert.ok(chime('[SETUP] Ring the intercom once (1/3).', '[AUDIO] Candidate too short or clipped; ignored.').message.length > 0);
console.log('Web UI: chime registration steps passed');

// Call progress restarts with each call.
const call = (...lines) => callProgress(lines);
assert.equal(call(), -1);
assert.equal(call('[SERVO] END press once: test'), -1, 'a local servo test is not a call');
assert.equal(call('[VOICE] Preparing streaming call.'), 0);
assert.equal(call('[VOICE] Preparing streaming call.', '[SERVO] CALL press once: 30'), 1);
assert.equal(call('[VOICE] Preparing streaming call.', '[VOICE] Call button operation complete; now connecting voice agent.'), 2);
assert.equal(call('[VOICE] Preparing streaming call.', '[VOICE] Response 0: recording paused, playing on speaker.'), 3);
assert.equal(call('[VOICE] Preparing streaming call.', '[VOICE] Listening: turn 1; max 30s / silence 1.2s.'), 4);
assert.equal(call('[VOICE] Preparing streaming call.', '[VOICE] Response 1: recording paused, playing on speaker.'), 5);
assert.equal(call('[VOICE] Preparing streaming call.', '[SERVO] END press once: 30'), 6);
assert.equal(call('[VOICE] Preparing streaming call.', '[VOICE] Call stopped; chime detection rearmed.'), CALL_STEPS.length);
assert.equal(call('[VOICE] Call ended; chime detection rearmed.', '[VOICE] Preparing streaming call.'), 0);
assert.equal(callCompleted(['[VOICE] Call stopped; chime detection rearmed.']), false);
assert.equal(callCompleted(['[VOICE] Call ended; chime detection rearmed.']), true);
console.log('Web UI: call progress passed');

// The page has one board, three servos, and no destructive control outside the guarded format.
const page = readFileSync(new URL('../calibration_ui/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../calibration_ui/app.js', import.meta.url), 'utf8');
for (const pin of ['GPIO 7', 'GPIO 8', 'GPIO 9']) assert(app.includes(pin), pin);
for (const removed of [/M5/, /E84/, /board-link/, /UDP/]) {
  assert(!removed.test(page), 'index.html: ' + removed);
  assert(!removed.test(app), 'app.js: ' + removed);
}
assert(!/color:#(?!1F3A5F|142336|8FA3BC|DDE5EF|E8EDF4|F2F2F7|1C1C1E|5A5A60|E5E5EA|fff)/i.test(page), 'navy theme only');
assert(app.includes("'/api/format'") && app.includes('confirm('), 'format asks first');
// Every button in the page is connected to something.
for (const [, id] of page.matchAll(/<button[^>]*\bid="([^"]+)"/g)) {
  assert(new RegExp(`\\$\\('#${id}'\\)\\.onclick`).test(app), 'unconnected button: ' + id);
}
// The routes must not jump the page to an element: main ids differ from the hashes.
for (const [, name] of page.matchAll(/<a href="#([a-z]+)"/g)) {
  assert(page.includes(`id="page-${name}"`), name);
  assert(!page.includes(`id="${name}"`), 'hash would scroll to #' + name);
}
console.log('Web UI: pins, theme and removed link concepts passed');
