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

// Shared mode follows the selected physical output, while the USB-only third stays available.
{
  const {pusherLayout} = context.MonbanLogic;
  for (const [mask, start, end, target, hidden] of [[1, 1, 1, 'c', 'e'], [2, 2, 2, 'e', 'c']]) {
    const layout = pusherLayout({pusher_schema_version: 1, enabled_mask: mask,
      call_start_pusher: start, call_end_pusher: end, manual_check_required: true}, 'c');
    assert.equal(layout.target, target);
    assert.ok(layout.targets.includes(target));
    assert.ok(layout.targets.includes('u'));
    assert.ok(!layout.targets.includes(hidden));
    assert.equal(layout.roles[target], '通話開始・終話');
    assert.equal(layout.roles[hidden], '未使用');
    assert.equal(layout.manualCheck, true);
  }
  const swapped = pusherLayout({pusher_schema_version: 1, enabled_mask: 3, call_start_pusher: 2, call_end_pusher: 1});
  assert.equal(swapped.start, 'e');
  assert.equal(swapped.roles.c, '終話');
  assert.equal(swapped.roles.e, '通話開始');
  assert.deepEqual(Array.from(pusherLayout().targets), ['c', 'e', 'u'], 'old firmware retains its physical ports');
}

// Neither an inactive output nor a manual-check condition sends a test. Only an explicit confirmation clears it.
{
  const {editor, requests} = fixture(action => state({manual_check_required: action !== 'confirm',
    pusher_schema_version: 1, enabled_mask: 2, call_start_pusher: 2, call_end_pusher: 2}));
  editor.apply(state({manual_check_required: true, pusher_schema_version: 1, enabled_mask: 2,
    call_start_pusher: 2, call_end_pusher: 2, active: true}));
  assert.equal(await editor.test('e'), false);
  assert.equal(requests.length, 0);
  assert.equal(await editor.confirmIdle(), true, 'idle confirmation is also allowed during calibration');
  assert.deepEqual(requests.map(r => r.action), ['confirm']);
  assert.equal(requests[0].body.confirm, 'INTERCOM_IDLE');
  assert.equal(await editor.test('c'), false, 'unused physical port never reaches the server');
  assert.equal(requests.length, 1);
  assert.equal(await editor.test('e'), true);
  assert.deepEqual(requests.map(r => r.action), ['confirm', 'test']);
}
{
  const {editor, requests} = fixture(() => refused('recovery_confirmation_failed'));
  editor.apply(state({manual_check_required: true}));
  assert.equal(await editor.confirmIdle(), false);
  assert.equal(await editor.test('c'), false);
  assert.deepEqual(requests.map(r => r.action), ['confirm'], 'failed confirmation is never replaced by a test press');
}
console.log('Web UI: physical mapping, shared port visibility and explicit recovery confirmation passed');

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
  editor.setAngleLocal('c', 'press', 41);
  await editor.commitAngle('c', 'press');
  editor.setTimingLocal('return_ms', 900);
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
// A step button's delayed commit after undo or save must not restart calibration: it pauses calls.
for (const finish of ['undo', 'save']) {
  const {editor, requests} = fixture(action => action === 'cancel' || action === 'save' ? state() : {ok: true});
  editor.setAngleLocal('c', 'press', 40);
  editor.setTimingLocal('return_ms', 800);
  editor.active = true;
  await editor[finish]();
  const before = requests.length;
  await editor.commitAngle('c', 'press');
  await editor.commitTiming('return_ms');
  assert.equal(requests.length, before, finish);
  assert.equal(editor.active, false, finish);
}
// A refused edit is still on screen, so save must send it and not report success with the old value.
{
  let refuse = true;
  const {editor, requests} = fixture(action => {
    if (action === 'begin' && refuse) { refuse = false; refused('servo_test_busy'); }
    return action === 'save' ? state({call_press: 77}) : {ok: true};
  });
  editor.setAngleLocal('c', 'press', 77);
  await editor.commitAngle('c', 'press');
  assert.equal(editor.message, errorText('servo_test_busy'));
  assert.equal(await editor.save(), true);
  assert.deepEqual(requests.map(r => r.action), ['begin', 'begin', 'angles', 'save']);
  assert.equal(requests[2].body.press, 77);
}
// A save the board refuses is not reported as saved.
{
  const {editor} = fixture(action => { if (action === 'begin') refused('servo_test_busy'); return {ok: true}; });
  editor.setAngleLocal('c', 'press', 77);
  assert.equal(await editor.save(), false);
  assert.equal(editor.dirty, true);
  assert.equal(editor.values.c.press, 77);
  assert.equal(editor.uncommitted.size, 1, 'still due');
}
// Undo during a begin that is still in flight: the cancel goes last, so calibration ends.
{
  let finishBegin;
  const {editor, requests} = fixture(action => {
    if (action === 'begin') return new Promise(resolve => { finishBegin = () => resolve({ok: true}); });
    return action === 'cancel' ? state() : {ok: true};
  });
  editor.setAngleLocal('c', 'press', 40);
  const commit = editor.commitAngle('c', 'press');
  await Promise.resolve();
  const undo = editor.undo();
  finishBegin();
  await Promise.all([commit, undo]);
  assert.equal(requests.at(-1).action, 'cancel');
  assert.equal(requests.filter(r => r.action === 'preview').length, 0, 'no servo move after undo');
  assert.equal(editor.dirty, false);
}
// A step button's delayed commit while the cancel is on its way must not start calibration again.
{
  let finishCancel;
  const {editor, requests} = fixture(action => action === 'cancel' ? new Promise(resolve => { finishCancel = () => resolve(state()); }) : {ok: true});
  editor.setAngleLocal('c', 'press', 40);
  const undo = editor.undo();
  await Promise.resolve();
  await editor.commitAngle('c', 'press');
  finishCancel();
  await undo;
  assert.deepEqual(requests.map(r => r.action), ['cancel']);
  assert.equal(editor.undoing, false);
}
// A refused cancel keeps the edit; a press never runs with an edit still on its way.
{
  const {editor} = fixture(action => { if (action === 'cancel') refused('servo_test_busy'); return {ok: true}; });
  editor.setAngleLocal('c', 'press', 77);
  assert.equal(editor.canTest(), false);
  assert.equal(await editor.test('c'), false);
  await editor.undo();
  assert.equal(editor.dirty, true);
  assert.equal(editor.values.c.press, 77);
  assert.equal(editor.uncommitted.size, 1);
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
assert.equal(call('[VOICE] Call ended; chime detection rearmed.', '[SERVO] CALL press once: 30'), -1);
assert.equal(call('[VOICE] Preparing streaming call.', '[VOICE] Call ended; chime detection rearmed.', '[SERVO] CALL press once: 30'), CALL_STEPS.length, 'a test press after the call');
assert.equal(call('[VOICE] Preparing streaming call.', '[MONITOR] [BOOT] Network task running: the board restarted while USB was away.'), -1);
assert.equal(callCompleted(['[VOICE] Call stopped; chime detection rearmed.']), false);
assert.equal(callCompleted(['[VOICE] Call ended; chime detection rearmed.']), true);
console.log('Web UI: call progress passed');

// The 3D model moves on the board's own lines.
const {sceneEvent, rackReach} = context.MonbanLogic;
const event = text => JSON.parse(JSON.stringify(sceneEvent(text)));
assert.deepEqual(event('[SERVO] CALL press once: 150 degrees for 300 ms; source=saved rest=180 pulse_us=1833 at_ms=10'), {type: 'press', key: 'call', degrees: 30, hold: 300});
assert.deepEqual(event('[SERVO] END press once: 30 degrees for 100 ms; source=saved rest=0 pulse_us=1166 at_ms=10'), {type: 'press', key: 'end', degrees: 30, hold: 100});
assert.deepEqual(event('[SERVO] UNLOCK returning to 0 degrees for 1000 ms; at_ms=5'), {type: 'release', key: 'unlock', seconds: 1});
assert.equal(event('[DETECTED] chime').type, 'ringing');
assert.deepEqual(event('[VOICE] Call button operation complete; now connecting voice agent.'), {type: 'screen', state: 'call'});
assert.deepEqual(event('[VOICE] Response 1: recording paused, playing on speaker.'), {type: 'sound', source: 'device'});
assert.deepEqual(event('[DIAG] speaker playing'), {type: 'sound', source: 'device'});
assert.deepEqual(event('[VOICE] Input streaming: sent=20 ms queued=3 frames rms=3541.'), {type: 'sound', source: 'visitor'});
assert.deepEqual(event('[VOICE] Playback complete: turn 0.'), {type: 'sound', source: null});
assert.deepEqual(event('[DIAG] loopback ok=1'), {type: 'sound', source: null});
assert.equal(event('[VOICE] Call ended; chime detection rearmed.').type, 'idle');
assert.equal(event('[MONITOR] [BOOT] Network task running: the board restarted while USB was away.').type, 'idle');
assert.equal(sceneEvent('[SERVO] Active source=saved CALL: GPIO=7 press=30 rest=0'), null);
// The rack: 4.5 mm pinion radius against the stroke and the gap to the key.
assert.equal(rackReach(180, 4.5, 4, 1.5).over, true, 'the old 180 degree default ran far past the rack');
assert.equal(rackReach(10, 4.5, 4, 1.5).short, true);
{
  const reach = rackReach(30, 4.5, 4, 1.5);
  assert.ok(!reach.over && !reach.short && Math.abs(reach.mm - 2.356) < 0.01 && Math.abs(reach.depth - 0.856) < 0.01);
  assert.equal(rackReach(30, 4.5, 4, null).short, false, 'no mechanism for this servo');
  assert.equal(rackReach(30, 4.5, 4, 2.2, 0.39).short, true, 'the tilt under load counts against the reach');
}
console.log('Web UI: 3D events and rack reach passed');

// The intercom table and fit check, by the same rules as capsule/fusion/mount_views.py.
const sceneContext = vm.createContext({window: {THREE: {}}});
vm.runInContext(readFileSync(new URL('../calibration_ui/scene/monban_scene.js', import.meta.url), 'utf8'), sceneContext);
const Scene = sceneContext.window.MonbanScene;
// The numbers the placement uses must describe the meshes that are drawn.
{
  vm.runInContext(readFileSync(new URL('../calibration_ui/scene/monban_meshes.js', import.meta.url), 'utf8'), sceneContext);
  const bounds = name => {
    const raw = Buffer.from(sceneContext.window.MONBAN_MESHES[name].p, 'base64');
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i + 6 <= raw.length; i += 6) {
      const x = raw.readInt16LE(i) / 50, y = raw.readInt16LE(i + 2) / 50;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return {x0, x1, y0, y1};
  };
  for (const [name, shape] of [['cap_base', Scene.SHAPES.capsule], ['sit_N_base', Scene.SHAPES.bird]]) {
    const b = bounds(name);
    const near = (a, want, what) => assert.ok(Math.abs(a - want) < 0.5, `${name} ${what}: mesh ${a}, table ${want}. Run scene/make_meshes.py and update SHAPES`);
    near(b.x0, shape.xc - shape.w / 2, 'left'); near(b.x1, shape.xc + shape.w / 2, 'right');
    near(b.y0, shape.y0, 'bottom'); near(b.y1, shape.y1, 'top');
  }
}
assert.deepEqual(Object.keys(Scene.DESIGNS), ['bird', 'matte']);
assert.ok(Object.keys(Scene.INTERCOMS).length >= 19);
for (const [id, item] of Object.entries(Scene.INTERCOMS)) {
  // Everything drawn on the face stays on the outline.
  const inside = (x, y, w, h) => Math.abs(x) + w / 2 <= item.W / 2 && Math.abs(y) + h / 2 <= item.H / 2;
  assert.ok(inside(...item.screen.slice(0, 4)), id + ': screen');
  for (const b of item.buttons) assert.ok(inside(b.cx, b.cy, b.w, b.h), id + ': ' + b.label);
  assert.ok(item.press.every(role => item.buttons.some(b => b.role === role)), id + ': pressed key missing');
}
for (const id of Object.keys(Scene.INTERCOMS)) {
  const spec = Scene.customize(id);
  for (const shape of ['bird', 'capsule']) {
    const placed = Scene.layout(spec, shape);
    assert.equal(placed.pushers.length, spec.press.length, id);
    for (const pusher of placed.pushers) assert.ok(Math.abs(pusher.py - placed.ry) > 13, id + ': the part sits off the rail');
  }
}
{
  const notes = shape => Array.from(Scene.fit(Scene.customize('vsmge20'), shape)).join(' ');
  assert.ok(notes('capsule').includes('充電台に約 6.9 mm'), notes('capsule'));
  assert.ok(notes('capsule').includes('通話キーに載るラックは 87%') || notes('capsule').includes('通話キーに載るラックは 88%'), notes('capsule'));
  assert.ok(notes('bird').includes('充電台に約 3.2 mm'), notes('bird'));
  assert.equal(Scene.fit(Scene.customize('vlme30'), 'capsule').length, 0);
  assert.ok(Array.from(Scene.fit(Scene.customize('vlwd623'), 'capsule')).join(' ').includes('重なります'));
  // Measured values replace the table: the rail follows the keys.
  const moved = Scene.customize('vlme30', {W: 140, D: 20, talk: {x: 10, y: -60}});
  assert.equal(moved.W, 140);
  assert.equal(moved.D, 20);
  assert.deepEqual(Array.from(Scene.pressPoint(moved.buttons.find(b => b.role === 'talk'))), [10, -60]);
  assert.equal(Scene.layout(moved, 'capsule').pushers[0].qy, -60);
}
console.log('Web UI: intercom table and fit check passed');

// The page has one board, three servos, and no destructive control outside the guarded format.
const page = readFileSync(new URL('../calibration_ui/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../calibration_ui/app.js', import.meta.url), 'utf8');
for (const pin of ['GPIO 7', 'GPIO 8', 'GPIO 9']) assert(app.includes(pin), pin);
for (const removed of [/M5/, /E84/, /board-link/, /UDP/]) {
  assert(!removed.test(page), 'index.html: ' + removed);
  assert(!removed.test(app), 'app.js: ' + removed);
}
assert(app.includes("'/api/format'") && app.includes('Modal.confirm('), 'format asks first');
// Everything the page loads comes from this repository.
for (const [, src] of page.matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert(src.startsWith('/'), 'not vendored: ' + src);
  readFileSync(new URL('../calibration_ui' + src, import.meta.url));
}
console.log('Web UI: pins, removed link concepts and vendored files passed');
