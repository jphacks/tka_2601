// Browser-independent rules of the bench page; tests/ui_test.mjs runs them in Node.
(() => {
  const ERROR_TEXT = {
    receiver_busy: '通話中かテスト中のため、今は動かせません',
    servo_test_busy: 'テストが終わってから操作してください',
    servo_busy: 'サーボが動いています',
    begin_required: '調整を始められませんでした',
    storage_unavailable: '本体に保存できませんでした',
    save_failed: '本体に保存できませんでした',
    pwm_unavailable: 'PWM を出せません',
    pwm_write_failed: 'PWM を出せません',
    servo_return_failed: 'サーボを戻せませんでした',
    servo_release_failed: 'サーボの信号を止められませんでした',
    test_not_running: 'テストは終わっています',
  };
  const errorText = code => ERROR_TEXT[code] || code;
  const RETRY = new Set(['servo_busy', 'returning_previous_servo']);

  function pickValues(s) {
    return {
      c: {rest: s.call_rest, press: s.call_press},
      e: {rest: s.end_rest, press: s.end_press},
      u: {rest: s.unlock_rest, press: s.unlock_press},
      call_delay_ms: s.call_delay_ms, call_hold_ms: s.call_hold_ms,
      end_hold_ms: s.end_hold_ms, unlock_hold_ms: s.unlock_hold_ms, return_ms: s.return_ms,
    };
  }

  // Unsaved edits live here. A preview moves the servo, so only the newest value of
  // each control is sent, and a test press is never queued behind an edit.
  class ServoEditor {
    constructor(api, sleep, onChange) {
      this.api = api; this.sleep = sleep; this.onChange = onChange;
      this.values = null; this.dirty = false; this.active = false;
      this.pending = new Map(); this.pumping = false;
      this.uncommitted = new Map(); // moved on screen, not yet sent to the board
      this.testing = false; this.motionBusy = false; this.requesting = false;
      this.motionError = ''; this.message = '';
    }
    changed() { this.onChange(); }
    apply(state) {
      if (this.active && !state.active && this.dirty && !this.requesting) {
        this.dirty = false; this.pending.clear(); this.uncommitted.clear();
        this.message = '2 分操作がなかったので、変更を取り消しました';
      }
      this.active = state.active;
      this.motionBusy = state.motion_busy;
      this.testing = state.test_busy;
      this.motionError = state.motion_error || '';
      if (!this.dirty) {
        this.values = pickValues(state);
        // After a page reload the board may still hold edits from before it.
        if (state.active && state.saved) this.dirty = JSON.stringify(this.values) !== JSON.stringify(pickValues(state.saved));
      }
      this.changed();
    }
    async begin() {
      if (this.active) return;
      await this.api('begin');
      this.active = true;
    }
    setAngleLocal(target, position, angle) {
      this.values[target][position] = angle;
      this.dirty = true; this.message = '';
      this.uncommitted.set(target + position, () => ({action: 'angles', body: {target, ...this.values[target]}}));
      this.changed();
    }
    commitAngle(target, position) {
      this.uncommitted.delete(target + position);
      this.pending.set(target + position, {action: 'preview', body: {target, position: position === 'press' ? 'p' : 'r', angle: this.values[target][position]}});
      return this.pump();
    }
    setTimingLocal(field, value) {
      this.values[field] = value;
      this.dirty = true; this.message = '';
      this.uncommitted.set(field, () => ({action: 'timing', body: {field, value: this.values[field]}}));
      this.changed();
    }
    commitTiming(field) {
      this.uncommitted.delete(field);
      this.pending.set(field, {action: 'timing', body: {field, value: this.values[field]}});
      return this.pump();
    }
    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        await this.begin();
        while (this.pending.size) {
          const [key, item] = this.pending.entries().next().value;
          try {
            await this.api(item.action, item.body);
            if (this.pending.get(key) === item) this.pending.delete(key);
          } catch (error) {
            if (RETRY.has(error.code)) { await this.sleep(200); continue; }
            this.pending.delete(key);
            this.message = errorText(error.code || error.message);
          }
        }
      } catch (error) {
        this.pending.clear();
        this.message = errorText(error.code || error.message);
      } finally {
        this.pumping = false;
        this.changed();
      }
    }
    async mirror(target) {
      if (this.motionBusy || this.testing || this.pumping || this.pending.size) return false;
      const value = this.values[target];
      const next = {rest: 180 - value.rest, press: 180 - value.press};
      try {
        await this.begin();
        await this.api('angles', {target, ...next}); // no motion until the next preview or test
        this.values[target] = next;
        this.dirty = true; this.message = '';
      } catch (error) { this.message = errorText(error.code || error.message); }
      this.changed();
      return true;
    }
    canTest() { return !this.testing && !this.motionBusy && !this.pumping && !this.pending.size && !this.requesting; }
    async test(target) {
      if (!this.canTest()) return false;
      this.requesting = true; this.message = '';
      this.changed();
      try {
        const state = await this.api('test', {target});
        this.testing = !!state.test_busy;
        this.motionBusy = !!state.motion_busy;
        return true;
      } catch (error) {
        this.message = errorText(error.code || error.message); // a refused press is never replayed
        return false;
      } finally {
        this.requesting = false;
        this.changed();
      }
    }
    async stopTest() {
      try { await this.api('stop_test'); } catch (error) { this.message = errorText(error.code || error.message); }
      this.changed();
    }
    async save() {
      if (this.requesting) return false;
      this.requesting = true;
      this.message = ''; // an earlier refused preview must not block saving
      try {
        // What is on screen is what gets saved: send it without moving anything.
        for (const [key, make] of this.uncommitted) this.pending.set(key, make());
        this.uncommitted.clear();
        await this.pump();
        while (this.pumping) await this.sleep(50);
        if (this.message) return false;
        const state = await this.api('save');
        this.dirty = false; this.active = false; this.message = '';
        this.values = pickValues(state);
        return true;
      } catch (error) {
        this.message = errorText(error.code || error.message);
        return false;
      } finally {
        this.requesting = false;
        this.changed();
      }
    }
    async undo() {
      this.pending.clear(); this.uncommitted.clear();
      try {
        const state = await this.api('cancel');
        this.dirty = false; this.active = false; this.message = '';
        this.values = pickValues(state);
      } catch (error) {
        if (error.code === 'begin_required') { this.dirty = false; this.message = ''; }
        else this.message = errorText(error.code || error.message);
      }
      this.changed();
    }
  }

  // Registration progress as the board reports it. -1 idle, 0-4 running, 5 finished.
  function chimeProgress(lines) {
    let step = -1, message = '';
    for (const text of lines) {
      if (text.includes('[BOOT] Network task running')) { step = -1; message = ''; }
      else if (text.includes('[SETUP] Keep quiet')) { step = 0; message = ''; }
      else if (text.includes('(1/3)')) { step = 1; message = ''; }
      else if (text.includes('(2/3)')) { step = 2; message = ''; }
      else if (text.includes('(3/3)')) { step = 3; message = ''; }
      else if (text.includes('[SETUP] Three recordings agree')) { step = 4; message = ''; }
      else if (text.includes('[SETUP] Verification passed') || text.includes('[SETUP] Model persistence verified')) { step = 5; message = ''; }
      else if (text.includes('[SETUP] Model persistence FAILED')) { step = -1; message = '本体に保存できませんでした'; }
      else if (text.includes('[SETUP] Registration cancelled')) { step = -1; message = ''; }
      else if (text.includes('[SETUP] Too noisy')) { step = -1; message = '周りの音が大きすぎます'; }
      else if (text.includes('[SETUP] Recordings differ')) { step = -1; message = '3 回の音が違いすぎます'; }
      else if (text.includes('[SETUP] Verification did not match')) { message = '登録した音と違います。もう一度鳴らしてください'; }
      else if (text.includes('[SETUP] Capture gap')) { step = -1; message = '音が途切れたので中止しました'; }
      else if (text.includes('[SETUP] Call started')) { step = -1; message = '通話が始まったので中止しました'; }
      else if (text.includes('[AUDIO] Candidate too short or clipped') && step >= 1 && step <= 4) { message = '短すぎるか、音が割れています。もう一度鳴らしてください'; }
      else if (text.includes('[AUDIO] Candidate longer than') && step >= 1 && step <= 4) { message = '4 秒より長い音は登録できません'; }
      else if (text.includes('[AUDIO] Command unavailable')) { message = '今は登録を始められません'; }
    }
    return {step, message};
  }

  const CALL_STEPS = ['待ち時間', '通話を押す', '接続', '挨拶', '聞き取り', '返答', '終了を押す'];
  // Position in the most recent call. -1 before any call; CALL_STEPS.length when finished.
  function callProgress(lines) {
    let at = -1;
    for (const text of lines) {
      if (text.includes('[VOICE] Preparing streaming call')) at = 0;
      // A servo test before or after a call is not part of it.
      if (at < 0 || at >= CALL_STEPS.length) continue;
      if (text.includes('[SERVO] CALL press once')) at = 1;
      else if (text.includes('[VOICE] Call button operation complete')) at = 2;
      else if (text.includes('[VOICE] Response 0:')) at = 3;
      else if (text.includes('[VOICE] Listening:')) at = 4;
      else if (/\[VOICE\] Response [1-9]/.test(text)) at = 5;
      else if (text.includes('[SERVO] END press once')) at = 6;
      else if (text.includes('Call ended;') || text.includes('Call stopped;') || text.includes('Playback/call state uncertain')) at = CALL_STEPS.length;
    }
    return at;
  }
  const callCompleted = lines => lines.some(text => text.includes('[VOICE] Call ended;'));

  // What one line from the board means for the 3D model, in the order it happened.
  const SERVO_NAMES = {CALL: 'call', END: 'end', UNLOCK: 'unlock'};
  function sceneEvent(text) {
    let m = text.match(/\[SERVO\] (CALL|END|UNLOCK) press once: (\d+) degrees for (\d+) ms;.* rest=(\d+)/);
    if (m) return {type: 'press', key: SERVO_NAMES[m[1]], degrees: Math.abs(Number(m[2]) - Number(m[4])), hold: Number(m[3])};
    m = text.match(/\[SERVO\] (CALL|END|UNLOCK) returning to \d+ degrees for (\d+) ms/);
    if (m) return {type: 'release', key: SERVO_NAMES[m[1]], seconds: Number(m[2]) / 1000};
    if (text.includes('[DETECTED]')) return {type: 'ringing'};
    if (text.includes('[VOICE] Call button operation complete')) return {type: 'screen', state: 'call'};
    if (/\[VOICE\] Response \d+:/.test(text) || text.includes('[DIAG] speaker playing') || text.includes('[DIAG] loopback playing')) return {type: 'sound', source: 'device'};
    if (text.includes('[VOICE] Input streaming:')) return {type: 'sound', source: 'visitor'};
    if (text.includes('[VOICE] Playback complete:') || text.includes('[VOICE] Input complete:') || /\[DIAG\] (speaker|loopback) ok=/.test(text)) return {type: 'sound', source: null};
    if (text.includes('Call ended;') || text.includes('Call stopped;') || text.includes('Playback/call state uncertain')) return {type: 'idle'};
    return null;
  }
  // How far the pinion's angle moves the rack, against what this intercom and exterior need.
  function rackReach(degrees, radius, stroke, gap) {
    const mm = radius * degrees * Math.PI / 180;
    return {mm, stroke, gap, over: mm > stroke, short: gap !== null && mm <= gap, depth: gap === null ? 0 : mm - gap};
  }

  globalThis.MonbanLogic = {ServoEditor, pickValues, errorText, chimeProgress, callProgress, callCompleted, CALL_STEPS, sceneEvent, rackReach};
})();
