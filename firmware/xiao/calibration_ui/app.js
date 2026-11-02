// The bench page: React and Ant Design from vendor/, no build step. Every value on it
// comes from the board, the server or the 3D model's own table; the model moves on what
// the board reports, so it shows the firmware's behaviour and not a script.
(() => {
  if (!globalThis.React || !globalThis.antd || !globalThis.MonbanScene || !globalThis.MonbanLogic) {
    document.getElementById('root').textContent = '画面の読み込みに失敗しました。再読み込みしてください。';
    return;
  }
  const {createElement: h, Fragment, useEffect, useRef, useState, useSyncExternalStore} = React;
  const {Alert, App: AntApp, Button, Card, ConfigProvider, InputNumber, Menu, Modal, Select, Slider, Steps, Tabs, Tag} = antd;
  const {ServoEditor, errorText, chimeProgress, callProgress, callCompleted, CALL_STEPS, sceneEvent, rackReach} = globalThis.MonbanLogic;
  const Scene = globalThis.MonbanScene;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  async function getJson(path) {
    const response = await fetch(path);
    const data = await response.json();
    if (!data.ok) throw Object.assign(new Error(data.error), {code: data.error});
    return data;
  }
  async function post(path, body = {}) {
    const response = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const data = await response.json();
    if (!data.ok) throw Object.assign(new Error(data.error), {code: data.error});
    return data;
  }
  const api = (action, body) => post('/api/' + action, body);
  const consoleCommand = command => post('/api/console', {command});

  // --- Shared state, refreshed by the pollers at the bottom.
  const store = {
    version: 0, page: '', target: null, simulated: false,
    device: {connected: false, voiceActive: false, recovery: false, stage: '', epoch: null, lines: [], logAfter: 0},
    diagnostics: null, mic: null, tune: null, conversation: null, conversationRevision: -1, tests: null, sound: null,
  };
  const listeners = new Set();
  const changed = () => { store.version += 1; listeners.forEach(listener => listener()); };
  const useStore = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => store.version);

  // --- Which intercom and exterior the 3D model shows; kept in this browser.
  const PREF_KEY = 'monban-bench-model';
  const pref = (() => {
    const fallback = {intercom: 'vsmge20', design: 'bird', measured: null};
    try {
      const saved = {...fallback, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}')};
      if (!Scene.INTERCOMS[saved.intercom]) saved.intercom = fallback.intercom;
      if (!Scene.DESIGNS[saved.design]) saved.design = fallback.design;
      return saved;
    } catch { return fallback; }
  })();
  function setPref(next) {
    Object.assign(pref, next);
    try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch { /* private windows render without memory */ }
    if (model.scene) {
      if ('design' in next) model.scene.setDesign(pref.design);
      if ('intercom' in next || 'measured' in next) model.scene.setIntercom(pref.intercom, pref.measured);
    }
    changed();
  }
  const currentSpec = () => Scene.customize(pref.intercom, pref.measured || {});
  const currentShape = () => Scene.DESIGNS[pref.design].shape;
  // The gap from the rack to this servo's key on the chosen intercom; null if it has no mechanism.
  function keyGap(target) {
    if (target === 'u') return null;
    const pushers = Scene.layout(currentSpec(), currentShape()).pushers;
    return (pushers.find(p => p.role === (target === 'c' ? 'talk' : 'end')) || pushers.find(p => p.role === 'talk')).gap;
  }
  const reachFor = (target, degrees) => rackReach(degrees, Scene.RP, Scene.SHAPES[currentShape()].stroke, keyGap(target));
  const rackMm = degrees => Scene.RP * degrees * Math.PI / 180;

  // --- The 3D model follows the board.
  const model = {
    scene: null, pressedAt: {}, ringTimer: null,
    apply(event) {
      if (!this.scene || !event) return;
      if (event.type === 'press') {
        this.pressedAt[event.key] = performance.now();
        this.scene.setPress(event.key, true, {mm: rackMm(event.degrees)});
      } else if (event.type === 'release') {
        // A log poll can bring press and return together; the press still shows.
        const shown = performance.now() - (this.pressedAt[event.key] || 0);
        setTimeout(() => this.scene && this.scene.setPress(event.key, false, {seconds: clamp(event.seconds, 0.2, 1)}), Math.max(0, 450 - shown));
      } else if (event.type === 'ringing') {
        this.ring(true);
      } else if (event.type === 'screen') {
        this.scene.setScreen(event.state);
      } else if (event.type === 'sound') {
        clearTimeout(this.ringTimer);
        this.scene.sound(event.source);
        store.sound = event.source;
      } else if (event.type === 'idle') {
        clearTimeout(this.ringTimer);
        this.scene.setScreen('off');
        this.scene.sound(null);
        store.sound = null;
      }
    },
    ring(onScreen) {
      if (!this.scene) return;
      if (onScreen) this.scene.setScreen('ringing');
      this.scene.sound('intercom');
      clearTimeout(this.ringTimer);
      this.ringTimer = setTimeout(() => {
        if (!this.scene) return;
        this.scene.sound(null);
        if (onScreen && !store.device.voiceActive) this.scene.setScreen('off');
      }, 1600);
    },
    // Dragging the servo controls moves the real servo; the rack shows the same thing.
    preview(target, position) {
      if (!this.scene || !editor.values) return;
      const key = {c: 'call', e: 'end', u: 'unlock'}[target], value = editor.values[target];
      if (position !== 'press') { this.scene.setPress(key, false); return; }
      this.scene.setPress(key, true, {mm: rackMm(Math.abs(value.press - value.rest)), seconds: 0.2});
      const hold = editor.values[{c: 'call_hold_ms', e: 'end_hold_ms', u: 'unlock_hold_ms'}[target]];
      setTimeout(() => this.scene && this.scene.setPress(key, false, {seconds: 0.3}), Math.max(hold, 450));
    },
  };

  const editor = new ServoEditor(api, sleep, changed);
  const servoNames = {c: '通話', e: '終了', u: '解錠'};
  const servoPins = {c: 'GPIO 7', e: 'GPIO 8', u: 'GPIO 9'};

  // --- Small shared pieces
  const Notice = ({text, type = 'error'}) => text ? h(Alert, {title: text, type, showIcon: false, style: {marginBottom: 16}}) : null;
  const Meter = ({value, tall, soft, mark, label}) => h('div', {className: `meter${tall ? ' tall' : ''}${soft ? ' soft' : ''}`, role: 'img', 'aria-label': label},
    h('div', {style: {width: value + '%'}}), mark === undefined ? null : h('div', {className: 'mark', style: {left: mark + '%'}}));
  // -1 is before the first step: antd always marks one step as current, so the whole bar fades.
  const StepBar = ({names, current}) => h(Steps, {size: 'small', responsive: false, titlePlacement: 'vertical', current: Math.max(current, 0),
    style: current < 0 ? {opacity: 0.4} : undefined, items: names.map(title => ({title}))});
  const Talk = () => {
    const messages = store.conversation?.messages || [];
    return messages.length
      ? h(Fragment, null, messages.map((message, index) => h('div', {key: index, className: 'bubble ' + message.speaker}, h('div', null, message.text))))
      : h('div', {className: 'sub'}, 'まだありません');
  };
  function LogView({lines, height}) {
    const ref = useRef(null);
    useEffect(() => { // follow the end unless the reader scrolled up
      const node = ref.current;
      if (node && node.scrollHeight - node.scrollTop - node.clientHeight < 80) node.scrollTop = node.scrollHeight;
    });
    return h('pre', {ref, role: 'log', tabIndex: 0, className: 'log', style: {height}}, lines.join('\n'));
  }

  // --- Top bar
  function TopBar() {
    useStore();
    const groups = [];
    Object.entries(Scene.INTERCOMS).forEach(([value, item]) => {
      let group = groups.find(g => g.label === item.group);
      if (!group) groups.push(group = {label: item.group, title: item.group, options: []});
      group.options.push({value, label: item.name});
    });
    const label = {xiao: 'XIAO', bench: 'bench', qemu: 'QEMU'}[store.target] || '';
    return h('header', {className: 'bar'},
      h('div', {className: 'brand'}, 'Monban'),
      h(Select, {'aria-label': 'インターホン', style: {flex: '0 1 340px', minWidth: 200}, value: pref.intercom, options: groups, popupMatchSelectWidth: 340,
        onChange: intercom => setPref({intercom, measured: null})}),
      h(Select, {'aria-label': '外装', style: {flex: '0 1 200px', minWidth: 170}, value: pref.design,
        options: Object.entries(Scene.DESIGNS).map(([value, design]) => ({value, label: h('span', null, h('span', {className: 'swatch', style: {background: design.swatch}}), design.name)})),
        onChange: design => setPref({design})}),
      h('div', {style: {flex: 1}}),
      h('div', {className: 'status'}, h('span', {className: 'dot' + (store.device.connected ? ' on' : '')}), `${label} ${store.device.connected ? '接続中' : '未接続'}`));
  }

  // --- 3D pane, on every screen
  function ScenePane() {
    useStore();
    const canvas = useRef(null);
    const [failed, setFailed] = useState(false);
    const [xray, setXray] = useState(false);
    const [measuring, setMeasuring] = useState(false);
    useEffect(() => {
      try {
        model.scene = Scene.mount(canvas.current, {intercom: pref.intercom, change: pref.measured, design: pref.design});
      } catch { setFailed(true); }
      return () => { if (model.scene) model.scene.dispose(); model.scene = null; };
    }, []);
    const spec = currentSpec();
    const notes = Scene.fit(spec, currentShape());
    const messages = store.conversation?.messages || [];
    const speaker = store.sound === 'device' ? 'ai' : store.sound === 'visitor' ? 'visitor' : null;
    const caption = speaker && store.device.voiceActive ? [...messages].reverse().find(message => message.speaker === speaker) : null;
    const set = patch => setPref({measured: {...(pref.measured || {}), ...patch}});
    const num = (label, span, value, min, max, patch) => h('label', {key: label, style: {gridColumn: `span ${span}`}}, label,
      h(InputNumber, {style: {display: 'block', width: '100%', marginTop: 2}, value: Math.round(value * 10) / 10, step: 0.5, min, max, controls: false,
        onChange: next => { if (typeof next === 'number' && next >= min && next <= max) set(patch(next)); }}));
    const fields = [
      num('幅 mm', 2, spec.W, 40, 400, W => ({W})), num('高さ mm', 2, spec.H, 40, 400, H => ({H})), num('奥行き mm', 2, spec.D, 8, 60, D => ({D})),
    ];
    [['talk', '通話'], ['end', '終了']].forEach(([role, name]) => {
      const key = spec.buttons.find(b => b.role === role && spec.press.includes(role));
      if (!key) return;
      const [x, y] = Scene.pressPoint(key);
      fields.push(num(`${name}キー 左右 mm`, 3, x, -200, 200, v => ({[role]: {x: v, y}})), num(`${name}キー 上下 mm`, 3, y, -200, 200, v => ({[role]: {x, y: v}})));
    });
    return h('aside', {className: 'pane', 'aria-label': 'MONBAN の 3D 表示'},
      h('div', {className: 'scene'},
        failed ? h(Alert, {type: 'error', title: 'この環境では 3D を表示できません', style: {margin: 12}}) : h('canvas', {ref: canvas, role: 'img', 'aria-label': 'インターホンに付けた MONBAN の 3D 表示'}),
        h(Button, {className: 'xray', type: xray ? 'primary' : 'default', ghost: xray, 'aria-pressed': xray,
          onClick: () => { setXray(!xray); if (model.scene) model.scene.setXray(!xray); }}, '中を透かす'),
        caption ? h('div', {className: 'caption ' + speaker}, caption.text) : null),
      h('div', {className: 'under'},
        h(Alert, {type: notes.length ? 'warning' : 'success', role: 'status', title: notes.length ? h(Fragment, null, notes.map(note => h('div', {key: note}, note))) : '当たる所はありません'}),
        h('div', {className: 'sub', style: {marginTop: 8}}, pref.measured ? '実測値で表示しています' : spec.rough ? '外形は公開値、キー配置は説明文からの仮置きです' : '外形は公開値、キー位置は推定です'),
        h(Button, {type: 'link', style: {padding: 0}, 'aria-expanded': measuring, onClick: () => setMeasuring(!measuring)}, '寸法とキー位置を変える'),
        measuring ? h(Fragment, null,
          h('div', {className: 'fields'}, fields),
          h(Button, {style: {marginTop: 8}, disabled: !pref.measured, onClick: () => setPref({measured: null})}, '表の値に戻す')) : null));
  }

  // --- Check page. Hearing and movement can only be answered by a person.
  const answers = new Map();
  const answerKey = () => 'monban-answers-' + store.device.epoch;
  function loadAnswers() {
    answers.clear();
    try { Object.entries(JSON.parse(localStorage.getItem(answerKey()) || '{}')).forEach(([key, value]) => answers.set(key, value)); }
    catch { /* private windows render without memory */ }
  }
  function setAnswer(key, value) {
    answers.set(key, value);
    try { localStorage.setItem(answerKey(), JSON.stringify(Object.fromEntries(answers))); } catch { /* same */ }
    changed();
  }
  let runningServo = null, checkMessage = '';
  async function runDiagnostic(key) {
    answers.delete(key);
    checkMessage = '';
    try { store.diagnostics = await post('/api/diagnostics', {target: key}); }
    catch (error) { checkMessage = error.message; }
    changed();
  }
  async function waitDiagnostic() {
    for (;;) {
      store.diagnostics = await getJson('/api/diagnostics');
      changed();
      if (!store.diagnostics.running) return;
      await sleep(300);
    }
  }
  async function runAllConnections() {
    for (const key of ['usb', 'wifi', 'api_https', 'api_wss']) {
      await waitDiagnostic();
      await runDiagnostic(key);
      await waitDiagnostic();
      // Without USB or Wi-Fi the later checks can only wait for their timeouts.
      if (key !== 'api_https' && store.diagnostics?.results[key].state === 'failed') return;
    }
  }
  async function runServoTest(target) {
    const key = 'servo-' + target;
    if (runningServo) return;
    runningServo = target;
    checkMessage = '';
    answers.delete(key);
    changed();
    try {
      await api('test', {target});
      for (;;) {
        await sleep(200);
        const state = await getJson('/api/state');
        if (!state.test_busy && !state.motion_busy) {
          setAnswer(key, state.motion_error ? 'ng' : 'ask');
          break;
        }
      }
    } catch (error) {
      checkMessage = errorText(error.code || error.message);
    }
    runningServo = null;
    changed();
  }
  function diagnosticRow(key, name, action, ask) {
    const result = store.diagnostics?.results[key], device = store.device;
    const running = result?.state === 'running';
    let status = 'idle', detail = result?.state === 'idle' || !result ? '未確認' : result.detail;
    if (running) detail = '確認中';
    else if (result?.state === 'failed' || result?.state === 'blocked' || result?.state === 'warning') status = 'ng';
    else if (result?.state === 'ok') status = ask ? answers.get(key) || 'ask' : 'ok';
    return {name, detail, status, action, ask, busy: running, run: () => runDiagnostic(key), key,
      disabled: !!store.diagnostics?.running || !device.connected || (device.voiceActive && key !== 'usb' && key !== 'wifi')};
  }
  const heard = ['聞こえた', '聞こえない'], moved = ['動いた', '動かない'];
  function micRow() {
    const mic = store.mic;
    if (!mic) return {key: 'mic', name: 'マイク', detail: '未確認', status: 'idle', meter: 0};
    const alive = mic.status === 1 && mic.pcm_max !== mic.pcm_min;
    return {key: 'mic', name: 'マイク', detail: mic.status === 2 ? 'マイクから読めません' : `音量 ${Math.round(mic.rms)} / 欠落 ${mic.errors}`,
      status: alive ? 'ok' : mic.status === 0 ? 'idle' : 'ng', meter: clamp(mic.rms * 100 / 3000, 0, 100)};
  }
  function servoRow(target) {
    const key = 'servo-' + target, running = runningServo === target, device = store.device;
    return {name: servoNames[target], detail: running ? '動かしています' : servoPins[target], status: running ? 'idle' : answers.get(key) || 'idle',
      action: '1 回押す', ask: moved, key, busy: running, run: () => runServoTest(target),
      disabled: !!runningServo || !device.connected || device.voiceActive};
  }
  function CheckRow({row}) {
    return h('div', {className: 'row'},
      h('div', {className: 'text'}, h('div', {className: 'name'}, row.name), h('div', {className: 'sub'}, row.detail),
        row.meter === undefined ? null : h('div', {style: {marginTop: 6}}, h(Meter, {value: row.meter, label: 'マイクの音量'}))),
      row.status === 'ok' ? h(Tag, {color: 'success'}, 'OK') : null,
      row.status === 'ng' ? h(Tag, {color: 'error'}, 'NG') : null,
      row.status === 'ask'
        ? h(Fragment, null, h(Button, {type: 'primary', onClick: () => setAnswer(row.key, 'ok')}, row.ask[0]), h(Button, {onClick: () => setAnswer(row.key, 'ng')}, row.ask[1]))
        : row.link ? h(Button, {href: row.link}, row.action)
        : row.action ? h(Button, {loading: row.busy, disabled: row.disabled, onClick: row.run}, row.action) : null);
  }
  function CheckPage() {
    useStore();
    const {device, mic} = store;
    const done = callCompleted(device.lines);
    const groups = [
      {title: 'つながり', rows: [diagnosticRow('usb', 'USB', '確認'), diagnosticRow('wifi', 'Wi-Fi', '確認'), diagnosticRow('api_https', 'サーバー', '確認'), diagnosticRow('api_wss', '音声の接続', '確認')]},
      {title: '音', rows: [micRow(), diagnosticRow('speaker', 'スピーカー', '鳴らす', heard), diagnosticRow('loopback', 'マイク → スピーカー', '録音して再生', heard)]},
      {title: 'サーボ', rows: ['c', 'e', 'u'].map(servoRow)},
      {title: '通しの確認', rows: [
        {key: 'chime', name: 'チャイム', detail: mic?.model ? `登録済み / 検知 ${mic.detected} 回` : '未登録', status: mic?.detected ? 'ok' : 'idle', link: '#chime', action: '登録へ'},
        {key: 'call', name: 'テスト通話', detail: done ? '通話が最後まで終わった' : '未確認', status: done ? 'ok' : 'idle', link: '#call', action: '通話へ'},
      ]},
    ];
    const rows = groups.flatMap(group => group.rows), count = rows.filter(row => row.status === 'ok').length;
    return h(Fragment, null,
      h('div', {className: 'head'}, h('h1', null, '動作確認'),
        h('b', null, `${count} / ${rows.length} 確認済み`),
        h(Button, {type: 'primary', size: 'large', disabled: !device.connected || !!store.diagnostics?.running,
          onClick: () => runAllConnections().catch(error => { checkMessage = error.message; changed(); })}, '通信をまとめて確認')),
      h('div', {style: {marginBottom: 16}}, h(Meter, {value: count * 100 / rows.length, label: `${count} / ${rows.length} 確認済み`})),
      h(Notice, {text: device.recovery ? '通話の状態が不明です。インターホンを確かめてから本体をリセットしてください' : checkMessage}),
      h('div', {className: 'grid'}, groups.map(group => h(Card, {key: group.title, size: 'small', title: group.title},
        group.rows.map(row => h(CheckRow, {key: row.key, row}))))));
  }

  // --- Servo page
  const holdField = {c: 'call_hold_ms', e: 'end_hold_ms', u: 'unlock_hold_ms'};
  function StepControl({label, value, min, max, step, text, write, commit, less, more}) {
    const timer = useRef(null);
    const nudge = sign => {
      write(clamp(value + sign * step, min, max));
      clearTimeout(timer.current);
      timer.current = setTimeout(commit, 300); // repeated taps send one preview
    };
    return h('div', {className: 'step-control'},
      h('div', {className: 'top'}, h('label', null, label),
        h(Button, {'aria-label': less, onClick: () => nudge(-1)}, '−'), h('output', null, text(value)), h(Button, {'aria-label': more, onClick: () => nudge(1)}, '＋')),
      h(Slider, {min, max, step, value, tooltip: {open: false}, 'aria-label': label, onChange: write, onChangeComplete: commit}));
  }
  function Gauge({rest, press}) {
    const point = degrees => { const a = Math.PI * (1 - degrees / 180); return [Math.round(160 + 118 * Math.cos(a)), Math.round(160 - 118 * Math.sin(a))]; };
    const [rx, ry] = point(rest), [px, py] = point(press);
    return h('svg', {viewBox: '0 0 320 180', style: {width: '100%', maxWidth: 360, display: 'block', margin: '0 auto'}, role: 'img', 'aria-label': `待機 ${rest} 度、押す位置 ${press} 度`},
      h('path', {d: 'M 30 160 A 130 130 0 0 1 290 160', fill: 'none', stroke: '#ECEEF2', strokeWidth: 10, strokeLinecap: 'round'}),
      h('line', {x1: 160, y1: 160, x2: rx, y2: ry, stroke: '#B5BEEB', strokeWidth: 6, strokeLinecap: 'round'}),
      h('line', {x1: 160, y1: 160, x2: px, y2: py, stroke: '#5E6AD2', strokeWidth: 8, strokeLinecap: 'round'}),
      h('circle', {cx: 160, cy: 160, r: 10, fill: '#5E6AD2'}));
  }
  function reachText(target, degrees) {
    const reach = reachFor(target, degrees);
    if (reach.gap === null) return {type: 'info', text: 'この構成に解錠を押す部品はありません'};
    if (reach.over) return {type: 'warning', text: `ラックは ${reach.mm.toFixed(1)} mm 動く計算です。可動は ${reach.stroke} mm までです`};
    if (reach.short) return {type: 'warning', text: `ラックは ${reach.mm.toFixed(1)} mm です。キーまで ${reach.gap.toFixed(1)} mm あるので届きません`};
    return {type: 'success', text: `ラックは ${reach.mm.toFixed(1)} mm 動き、キーを ${reach.depth.toFixed(1)} mm 押します`};
  }
  function ServoPage() {
    useStore();
    const [target, setTarget] = useState('c');
    const device = store.device;
    if (!editor.values) return h(Fragment, null, h('div', {className: 'head'}, h('h1', null, 'サーボ調整')), h('div', {className: 'sub'}, device.connected ? '本体の設定を読んでいます' : 'XIAO の接続を待っています'));
    const {rest, press} = editor.values[target];
    const angle = (key, label) => ({label, min: 0, max: 180, step: 1, value: editor.values[target][key], text: v => v + '°', less: label + 'を 1° 減らす', more: label + 'を 1° 増やす',
      write: v => editor.setAngleLocal(target, key, v),
      commit: () => { model.preview(target, key); editor.commitAngle(target, key); }});
    const time = (field, label, min, max) => ({label, min, max, step: 100, value: editor.values[field], text: v => (v / 1000).toFixed(1) + ' 秒', less: label + 'を短く', more: label + 'を長く',
      write: v => editor.setTimingLocal(field, v), commit: () => editor.commitTiming(field)});
    const controls = [angle('rest', '待機位置'), angle('press', '押す位置'), time(holdField[target], '押す時間', 100, 2000), time('return_ms', '戻す時間', 100, 3000)];
    if (target === 'c') controls.push(time('call_delay_ms', '押す前の待ち時間', 0, 30000));
    const reach = reachText(target, Math.abs(press - rest));
    return h(Fragment, null,
      h('div', {className: 'head'}, h('h1', null, 'サーボ調整'),
        h('b', null, editor.dirty ? '未保存' : '保存済み'),
        h(Button, {size: 'large', disabled: !editor.dirty, onClick: () => editor.undo()}, '元に戻す'),
        h(Button, {size: 'large', type: 'primary', disabled: !editor.dirty || !device.connected, onClick: () => editor.save()}, '本体に保存')),
      h(Notice, {text: editor.message || (editor.motionError ? errorText(editor.motionError) : '')}),
      h(Tabs, {activeKey: target, type: 'card', onChange: key => { setTarget(key); if (model.scene) model.scene.look({c: 'call', e: 'end', u: 'unlock'}[key]); },
        items: ['c', 'e', 'u'].map(key => ({key, label: `${servoNames[key]}（${servoPins[key]}）`}))}),
      h('div', {className: 'grid'},
        h(Card, {size: 'small'},
          h(Gauge, {rest, press}),
          h('div', {style: {display: 'flex', justifyContent: 'center', gap: 24, margin: '8px 0 12px', fontSize: 14}},
            h('span', {className: 'sub'}, `待機 ${rest}°`), h('b', null, `押す ${press}°`), h('span', {className: 'sub'}, `動く量 ${Math.abs(press - rest)}°`)),
          h(Alert, {type: reach.type, title: reach.text, style: {marginBottom: 12}}),
          h(Button, {type: 'primary', size: 'large', block: true, disabled: !device.connected || device.voiceActive || (!editor.testing && !editor.canTest()),
            onClick: () => editor.testing ? editor.stopTest() : editor.test(target)}, editor.testing ? 'テストを止める' : servoNames[target] + 'を 1 回押す'),
          h(Button, {type: 'link', block: true, style: {marginTop: 4}, disabled: !device.connected || device.voiceActive || !editor.canTest(), onClick: () => editor.mirror(target)}, '向きを反転')),
        h(Card, {size: 'small'}, controls.map(control => h(StepControl, {key: target + control.label, ...control})))));
  }

  // --- Audio page
  const tuneDraft = {};
  function TuneSlider({id, field, valueKey, label, min, max, step, unit = ''}) {
    const value = tuneDraft[valueKey] ?? store.tune?.[valueKey] ?? min;
    return h(Fragment, null,
      h('div', {className: 'kv', style: {marginTop: 12}}, h('span', {id}, label), h('b', null, value + unit)),
      h(Slider, {min, max, step, value, tooltip: {open: false}, 'aria-labelledby': id, disabled: !store.tune,
        onChange: next => { tuneDraft[valueKey] = next; changed(); },
        onChangeComplete: async next => {
          try { store.tune = await api('tune', {field, value: next}); audioState = '保存済み'; }
          catch (error) { audioState = errorText(error.code || error.message); }
          delete tuneDraft[valueKey];
          changed();
        }}));
  }
  let audioState = '';
  function chimeVerdict() {
    const {mic, tune} = store;
    const limit = mic?.model ? mic.threshold * (tune?.chime_margin ?? 100) / 100 : null;
    const score = mic && mic.last_score >= 0 ? mic.last_score : null;
    return {limit, score, text: limit === null ? '未登録' : score === null ? '未判定' : score <= limit ? 'チャイムと判定' : 'チャイムではないと判定'};
  }
  function AudioPage() {
    useStore();
    const {mic, tune, device, diagnostics} = store;
    const rms = mic ? Math.round(mic.rms) : 0;
    const gate = tuneDraft.voice_rms_gate ?? tune?.voice_rms_gate ?? 600;
    const gateMax = Math.max(3000, gate);
    const percent = value => clamp(value * 100 / gateMax, 0, 100);
    const scale = value => clamp(value * 100 / 0.3, 0, 100);
    const {limit, score, text} = chimeVerdict();
    const busy = !!diagnostics?.running || !device.connected || device.voiceActive;
    return h(Fragment, null,
      h('div', {className: 'head'}, h('h1', null, '音の調整'), h('b', null, audioState)),
      h('div', {className: 'grid'},
        h(Card, {size: 'small', title: 'マイク'},
          h('div', {style: {display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8}},
            h('span', {style: {fontSize: 36, fontWeight: 700}}, rms), h('span', {className: 'sub'}, '音量'),
            h('b', {style: {marginLeft: 'auto'}}, rms >= gate ? '声として検出' : '無音')),
          h(Meter, {tall: true, soft: true, value: percent(rms), mark: percent(gate), label: `音量 ${rms}、話し始めの音量 ${gate}`}),
          h(TuneSlider, {id: 'gate-label', field: 'gate', valueKey: 'voice_rms_gate', label: '話し始めの音量', min: 30, max: gateMax, step: 10}),
          h(Button, {disabled: busy, loading: diagnostics?.running === 'loopback', onClick: () => runDiagnostic('loopback')}, '3 秒録音して再生')),
        h(Card, {size: 'small', title: 'スピーカー'},
          h(TuneSlider, {id: 'volume-label', field: 'volume', valueKey: 'speaker_volume', label: '音量', min: 0, max: 100, step: 5, unit: '%'}),
          h(Button, {type: 'primary', size: 'large', block: true, disabled: busy, loading: diagnostics?.running === 'speaker', onClick: () => runDiagnostic('speaker')}, 'この音量で鳴らす')),
        h(Card, {size: 'small', title: 'チャイムの判定'},
          h('div', {style: {position: 'relative'}}, h(Meter, {tall: true, soft: true, value: limit === null ? 0 : scale(limit), mark: score === null ? undefined : scale(score),
            label: `直近の距離 ${score === null ? 'なし' : score.toFixed(3)}、判定の上限 ${limit === null ? 'なし' : limit.toFixed(3)}`})),
          h('div', {style: {display: 'flex', fontSize: 14, marginTop: 8}},
            h('span', {style: {flex: 1}}, '直近の距離 ', h('b', null, score === null ? '-' : score.toFixed(3))),
            h('span', null, '判定の上限 ', h('b', null, limit === null ? '-' : limit.toFixed(3)))),
          h(TuneSlider, {id: 'margin-label', field: 'margin', valueKey: 'chime_margin', label: '判定の幅', min: 50, max: 200, step: 5, unit: '%'}),
          h('b', null, text))));
  }

  // --- Sounds only the bench firmware's scripted microphone can make
  async function simulate(sound) {
    model.ring(sound === 'chime');
    await post('/api/simulate', {sound});
  }

  // --- Chime page
  const chimeSteps = ['静かに', '1 回目', '2 回目', '3 回目', '確認'];
  const chimeScreens = [
    ['静かにしてください', '周りの音を 5 秒測っています'],
    ['チャイムを鳴らしてください', '1 回目'],
    ['もう一度鳴らしてください', '2 回目'],
    ['もう一度鳴らしてください', '3 回目'],
    ['確認のため、もう一度鳴らしてください', '確認'],
    ['登録しました', '次に鳴らすと検知します'],
  ];
  let chimeError = '';
  function ChimePage() {
    useStore();
    const {mic, device, tune} = store;
    const {step, message} = chimeProgress(device.lines);
    const running = step >= 0 && step <= 4, finished = step === 5;
    const needsFormat = mic?.storage === false, registered = !!mic?.model;
    const [title, sub] = running || finished ? chimeScreens[step] : needsFormat ? ['保存領域が未初期化です', ''] : [registered ? '登録済み' : '未登録', ''];
    const fail = error => { chimeError = error.message; changed(); };
    const limit = registered ? (mic.threshold * (tune?.chime_margin ?? 100) / 100).toFixed(3) : '-';
    return h('div', {style: {maxWidth: 760}},
      h('div', {className: 'head'}, h('h1', null, 'チャイム登録')),
      h('div', {style: {marginBottom: 16}}, h(StepBar, {names: chimeSteps, current: finished ? chimeSteps.length : step})),
      h(Notice, {text: message || chimeError}),
      h(Card, {style: {textAlign: 'center', marginBottom: 16}},
        h('div', {style: {fontSize: 28, fontWeight: 700, marginBottom: 20}}, title),
        h('div', {style: {maxWidth: 480, margin: '0 auto 8px'}}, h(Meter, {tall: true, value: mic ? clamp(mic.rms * 100 / 3000, 0, 100) : 0, label: 'マイクの音量'})),
        h('div', {className: 'sub', style: {marginBottom: 20, minHeight: 22}}, sub),
        h('div', {style: {display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12}},
          !running && !needsFormat ? h(Button, {type: 'primary', size: 'large', disabled: !device.connected || device.voiceActive, onClick: () => { chimeError = ''; consoleCommand('e').catch(fail); }}, registered || finished ? '登録し直す' : '登録を始める') : null,
          needsFormat ? h(Button, {type: 'primary', size: 'large', disabled: !device.connected, onClick: () => Modal.confirm({title: '保存領域を初期化します', okText: '初期化', cancelText: 'やめる',
            onOk: () => post('/api/format', {confirm: 'FORMAT_AUDIO_STORAGE'}).catch(fail)})}, '保存領域を初期化') : null,
          running && store.simulated ? h(Button, {type: 'primary', size: 'large', disabled: step === 0, onClick: () => simulate('chime').catch(fail)}, 'チャイムを鳴らす') : null,
          running ? h(Button, {size: 'large', onClick: () => consoleCommand('x').catch(fail)}, '中止') : null)),
      h(Card, {size: 'small'},
        h('div', {className: 'row'}, h('span', {className: 'text'}, '登録'), h('b', null, registered ? '登録済み' : '未登録')),
        h('div', {className: 'row'}, h('span', {className: 'text'}, '検知した回数'), h('b', null, (mic?.detected ?? 0) + ' 回')),
        h('div', {className: 'row'}, h('span', {className: 'text'}, '直近の距離 / 上限'), h('b', null, `${mic && mic.last_score >= 0 ? mic.last_score.toFixed(3) : '-'} / ${limit}`))));
  }

  // --- Call page
  let callError = '';
  function CallPage() {
    useStore();
    const {device} = store;
    const at = callProgress(device.lines);
    return h(Fragment, null,
      h('div', {className: 'head'}, h('h1', null, 'テスト通話'),
        h(Button, {type: 'primary', size: 'large', disabled: !device.connected || device.recovery,
          onClick: () => { callError = ''; consoleCommand(device.voiceActive ? 'q' : 'c').catch(error => { callError = error.message; changed(); }); }},
        device.voiceActive ? '通話を止める' : '通話を始める')),
      h(Notice, {text: callError}),
      h(Card, {style: {marginBottom: 16}},
        h('div', {role: 'status', 'aria-live': 'polite', style: {fontSize: 22, fontWeight: 700, marginBottom: 16}},
          device.recovery ? '通話の状態が不明です。インターホンを確かめてから本体をリセットしてください' : device.voiceActive ? device.stage : '待機中'),
        h(StepBar, {names: CALL_STEPS, current: at})),
      h('div', {className: 'grid'},
        h(Card, {size: 'small', title: '会話', style: {minHeight: 320}}, h(Talk)),
        h('div', null, h('div', {className: 'name', style: {fontWeight: 500, marginBottom: 8}}, '本体のログ'), h(LogView, {lines: device.lines.slice(-300), height: 320}))));
  }

  // --- Virtual board: run the bench or QEMU firmware and watch the model.
  let virtualError = '';
  function VirtualPage() {
    useStore();
    const {device, mic, target, simulated} = store;
    const at = callProgress(device.lines);
    const {limit, score, text} = chimeVerdict();
    const fail = error => { virtualError = errorText(error.code || error.message); changed(); };
    const press = letter => { virtualError = ''; api('test', {target: letter}).catch(fail); };
    const canPress = device.connected && !device.voiceActive;
    return h(Fragment, null,
      h('div', {className: 'head'}, h('h1', {role: 'status', 'aria-live': 'polite'}, device.voiceActive ? device.stage : '待機中')),
      h(Notice, {text: virtualError}),
      target === 'qemu' ? h(Notice, {type: 'info', text: 'QEMU に音声と Wi-Fi はありません。サーボの動きを試せます'}) : null,
      simulated && mic && !mic.model ? h(Notice, {type: 'warning', text: 'チャイムが未登録です。先にチャイムの画面で登録すると、鳴らしたときに通話が始まります'}) : null,
      h(Card, {size: 'small', style: {marginBottom: 16}}, h(StepBar, {names: CALL_STEPS, current: at})),
      h(Card, {size: 'small', style: {marginBottom: 16}},
        h(Button, {type: 'primary', size: 'large', block: true, disabled: !simulated || !canPress, onClick: () => { virtualError = ''; simulate('chime').catch(fail); }}, 'チャイムを鳴らす'),
        h('div', {style: {display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginTop: 8}},
          h(Button, {disabled: !simulated || !canPress, onClick: () => { virtualError = ''; simulate('other').catch(fail); }}, '違う音を鳴らす'),
          h(Button, {disabled: !canPress, onClick: () => press('c')}, '通話キーを押す'),
          h(Button, {disabled: !canPress, onClick: () => press('e')}, '終了キーを押す'),
          h(Button, {disabled: !device.voiceActive, onClick: () => consoleCommand('q').catch(fail)}, '通話を止める'))),
      h('div', {className: 'grid'},
        h(Card, {size: 'small', title: '音'},
          h('div', {className: 'kv'}, h('span', null, 'マイク'), h('span', null, mic ? `音量 ${Math.round(mic.rms)}` : '未取得')),
          h('div', {style: {margin: '6px 0 12px'}}, h(Meter, {value: mic ? clamp(mic.rms * 100 / 3000, 0, 100) : 0, label: 'マイクの音量'})),
          h('div', {className: 'kv'}, h('span', null, 'スピーカー'), h('span', null, store.sound === 'device' ? '再生中' : '停止')),
          h('div', {className: 'kv', style: {marginTop: 12}}, h('span', null, 'チャイムの判定'), h('span', null, score === null || limit === null ? text : `${text}（距離 ${score.toFixed(3)}）`))),
        h(Card, {size: 'small', title: '会話'}, h(Talk))));
  }

  // --- Test page: runs the same commands as the terminal and CI.
  const NOT_ON_BOARD = ['Wi-Fi、TLS、WSS', 'マイクの音', 'スピーカーの音', 'サーボの実際の角度', 'USB シリアルでの起動', '電源の落ち込み', '実際のチャイムでの検知'];
  function TestsPage() {
    useStore();
    const [shown, setShown] = useState('host');
    const [message, setMessage] = useState('');
    const tests = store.tests;
    if (!tests) return h('div', {className: 'sub'}, '読み込んでいます');
    const run = suite => { setMessage(''); setShown(suite === 'all' ? 'host' : suite); post('/api/tests', {suite}).then(data => { store.tests = data; changed(); }).catch(error => setMessage(error.message)); };
    const busy = !!tests.running || tests.queued.length > 0;
    const entries = Object.entries(tests.suites), okCount = entries.filter(([, s]) => s.state === 'ok').length;
    const detail = s => s.state === 'running' ? '実行中' : s.state === 'waiting' ? '順番待ち' : s.state === 'idle' ? '未実行' : s.state === 'stopped' ? '止めました' : `${s.seconds} 秒`;
    const current = tests.suites[tests.running || shown] ? tests.running || shown : shown;
    return h(Fragment, null,
      h('div', {className: 'head'}, h('h1', null, 'テスト'),
        h('b', null, `${okCount} / ${entries.length} 成功`),
        busy ? h(Button, {size: 'large', onClick: () => post('/api/tests', {stop: true}).catch(error => setMessage(error.message))}, '止める') : null,
        h(Button, {type: 'primary', size: 'large', disabled: busy, onClick: () => run('all')}, 'すべて実行')),
      h(Notice, {text: message}),
      h('div', {className: 'grid'},
        h('div', {className: 'stack'},
          h(Card, {size: 'small'}, entries.map(([key, suite]) => h('div', {key, className: 'row'},
            h('div', {className: 'text'}, h('div', {className: 'name'}, suite.name), h('div', {className: 'sub'}, detail(suite))),
            suite.state === 'ok' ? h(Tag, {color: 'success'}, '成功') : suite.state === 'failed' ? h(Tag, {color: 'error'}, '失敗') : null,
            h(Button, {type: 'link', onClick: () => setShown(key)}, 'ログ'),
            h(Button, {disabled: busy, loading: tests.running === key, onClick: () => run(key)}, '実行')))),
          store.target === 'xiao' ? null : h(Card, {size: 'small', title: '実機が届くまで確かめられない'},
            NOT_ON_BOARD.map(text => h('div', {key: text, className: 'row'}, text)))),
        h('div', null, h('div', {style: {fontWeight: 500, marginBottom: 8}}, tests.suites[current].name),
          h(LogView, {lines: tests.suites[current].lines.length ? tests.suites[current].lines : ['未実行'], height: 520}))));
  }

  // --- Layout
  const PAGES = {virtual: ['仮想ボード', VirtualPage], tests: ['テスト', TestsPage], check: ['動作確認', CheckPage], servo: ['サーボ', ServoPage],
    audio: ['音', AudioPage], chime: ['チャイム', ChimePage], call: ['テスト通話', CallPage]};
  const pageKeys = () => Object.keys(PAGES).filter(key => key !== 'virtual' || store.target !== 'xiao');
  function route() {
    const wanted = location.hash.slice(1);
    store.page = pageKeys().includes(wanted) ? wanted : store.target && store.target !== 'xiao' ? 'virtual' : 'check';
    window.scrollTo(0, 0);
    changed();
  }
  function Root() {
    useStore();
    const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 900px)').matches);
    useEffect(() => {
      const query = matchMedia('(max-width: 900px)'), update = () => setNarrow(query.matches);
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }, []);
    const Page = PAGES[store.page]?.[1];
    return h(ConfigProvider, {theme: {token: {colorPrimary: '#5E6AD2', colorLink: '#5E6AD2', colorSuccess: '#27A644', colorError: '#FF4D4F', colorText: '#17191E', borderRadius: 8, controlHeight: 40,
      fontFamily: "-apple-system, system-ui, 'Noto Sans JP', 'Yu Gothic UI', sans-serif"},
      components: {Menu: {itemSelectedBg: '#F0F4FF', itemSelectedColor: '#5E6AD2', itemBorderRadius: 10, itemHeight: 48}}}},
    h(AntApp, null,
      h(TopBar),
      h('div', {className: 'body'},
        h('nav', {className: 'side', 'aria-label': '画面'},
          h(Menu, {mode: narrow ? 'horizontal' : 'inline', selectedKeys: [store.page], items: pageKeys().map(key => ({key, label: PAGES[key][0]})),
            onClick: ({key}) => { location.hash = key; }})),
        h('main', {className: 'main'}, Page ? h(Page) : null),
        h(ScenePane))));
  }

  // --- Pollers. Each waits for its own request, so a slow board never piles them up.
  async function every(ms, step) {
    for (;;) {
      try { await step(); } catch { /* the connection state is shown by the log poller */ }
      await sleep(ms);
    }
  }
  every(300, async () => {
    const device = store.device;
    let data;
    try { data = await getJson('/api/logs?after=' + device.logAfter); }
    catch (error) { device.connected = false; changed(); throw error; }
    let replay = false;
    if (data.epoch !== device.epoch) {
      device.epoch = data.epoch; device.lines = []; device.logAfter = 0;
      loadAnswers();
      data = await getJson('/api/logs?after=0');
      replay = true; // what happened before this page opened does not move the model
    }
    device.connected = data.connected;
    device.voiceActive = data.voice_active;
    device.recovery = data.recovery_required;
    device.stage = data.stage;
    device.logAfter = data.next;
    const texts = data.lines.map(line => line.text);
    device.lines.push(...texts);
    if (device.lines.length > 500) device.lines.splice(0, device.lines.length - 500);
    if (!replay) texts.forEach(text => model.apply(sceneEvent(text)));
    if (texts.length || replay) changed();
  });
  let lastSeen = '';
  const report = () => {
    const seen = JSON.stringify([store.device.connected, store.device.voiceActive, store.device.stage]);
    if (seen !== lastSeen) { lastSeen = seen; changed(); }
  };
  every(500, report);
  every(1000, async () => {
    store.diagnostics = await getJson('/api/diagnostics');
    changed();
  });
  every(500, async () => {
    if (!store.device.connected || !['check', 'audio', 'chime', 'virtual'].includes(store.page)) return;
    store.mic = await getJson('/api/mic');
    if (!store.tune) store.tune = await getJson('/api/tune');
    changed();
  });
  every(1000, async () => {
    if (!store.device.connected || (store.page !== 'servo' && editor.values)) return;
    editor.apply(await getJson('/api/state'));
  });
  every(1000, async () => {
    if (!store.device.voiceActive && !['call', 'virtual'].includes(store.page)) return;
    const data = await getJson('/api/conversations?after=' + store.conversationRevision);
    if (data.changed) { store.conversationRevision = data.revision; store.conversation = data.session; changed(); }
  });
  every(1000, async () => {
    if (store.page !== 'tests') return;
    store.tests = await getJson('/api/tests');
    changed();
  });

  window.addEventListener('hashchange', route);
  ReactDOM.createRoot(document.getElementById('root')).render(h(Root));
  getJson('/api/target').then(data => { store.target = data.target; store.simulated = data.simulated_sound; route(); })
    .catch(() => { store.target = 'xiao'; route(); });
})();
