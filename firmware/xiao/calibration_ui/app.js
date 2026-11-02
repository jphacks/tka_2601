(() => {
  const {ServoEditor, errorText, chimeProgress, callProgress, callCompleted, CALL_STEPS} = globalThis.MonbanLogic;
  const $ = selector => document.querySelector(selector);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }
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
  const device = {connected: false, voiceActive: false, recovery: false, stage: '', epoch: null, lines: [], logAfter: 0};
  let diagnostics = null, mic = null, tune = null;
  let page = 'check';

  function notice(node, text) {
    node.textContent = text || '';
    node.hidden = !text;
  }

  // --- Navigation
  function showPage() {
    const wanted = location.hash.slice(1);
    page = document.getElementById('page-' + wanted) ? wanted : 'check';
    document.querySelectorAll('[data-page]').forEach(node => { node.hidden = node.id !== 'page-' + page; });
    document.querySelectorAll('nav a').forEach(link => {
      if (link.getAttribute('href') === '#' + page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    render();
  }

  // --- Check page. Hearing and movement can only be answered by a person.
  const answers = new Map();
  const answerKey = () => 'monban-answers-' + device.epoch;
  function loadAnswers() {
    answers.clear();
    try { Object.entries(JSON.parse(localStorage.getItem(answerKey()) || '{}')).forEach(([key, value]) => answers.set(key, value)); }
    catch { /* private windows render without memory */ }
  }
  function setAnswer(key, value) {
    answers.set(key, value);
    try { localStorage.setItem(answerKey(), JSON.stringify(Object.fromEntries(answers))); } catch { /* same */ }
    render();
  }
  const servoNames = {c: '通話', e: '終了', u: '解錠'};
  const servoPins = {c: 'GPIO 7', e: 'GPIO 8', u: 'GPIO 9'};
  let runningServo = null, checkMessage = '', checkSignature = '', micDetail = null, micFill = null;

  async function runDiagnostic(key) {
    answers.delete(key);
    checkMessage = '';
    try { diagnostics = await post('/api/diagnostics', {target: key}); }
    catch (error) { checkMessage = error.message; }
    render();
  }
  async function runAllConnections() {
    for (const key of ['usb', 'wifi', 'api_https', 'api_wss']) {
      await waitDiagnostic();
      await runDiagnostic(key);
      await waitDiagnostic();
      // Without USB or Wi-Fi the later checks can only wait for their timeouts.
      if (key !== 'api_https' && diagnostics?.results[key].state === 'failed') return;
    }
  }
  async function waitDiagnostic() {
    while (true) {
      diagnostics = await getJson('/api/diagnostics');
      render();
      if (!diagnostics.running) return;
      await sleep(300);
    }
  }
  $('#check-all').onclick = () => runAllConnections().catch(error => { checkMessage = error.message; render(); });
  async function runServoTest(target) {
    const key = 'servo-' + target;
    if (runningServo) return;
    runningServo = target;
    checkMessage = '';
    answers.delete(key);
    render();
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
    render();
  }
  function diagnosticRow(key, name, action, ask) {
    const result = diagnostics?.results[key];
    const running = result?.state === 'running';
    let status = 'idle', detail = result?.state === 'idle' || !result ? '未確認' : result.detail;
    if (running) detail = '確認中';
    else if (result?.state === 'failed' || result?.state === 'blocked') status = 'ng';
    else if (result?.state === 'warning') status = 'ng';
    else if (result?.state === 'ok') {
      status = ask ? answers.get(key) || 'ask' : 'ok';
    }
    return {name, detail, status, action, ask, busy: running, run: () => runDiagnostic(key), key,
      disabled: !!diagnostics?.running || !device.connected || (device.voiceActive && key !== 'usb' && key !== 'wifi')};
  }
  const heard = ['聞こえた', '聞こえない'], moved = ['動いた', '動かない'];
  function micRow() {
    if (!mic) return {name: 'マイク', detail: '未確認', status: 'idle', meter: 0};
    const alive = mic.status === 1 && mic.pcm_max !== mic.pcm_min;
    return {name: 'マイク', detail: mic.status === 2 ? 'マイクから読めません' : `音量 ${Math.round(mic.rms)} / 欠落 ${mic.errors}`,
      status: alive ? 'ok' : mic.status === 0 ? 'idle' : 'ng', meter: clamp(mic.rms * 100 / 3000, 0, 100)};
  }
  function servoRow(target) {
    const key = 'servo-' + target;
    const running = runningServo === target;
    const value = answers.get(key);
    return {name: servoNames[target], detail: running ? '動かしています' : servoPins[target], status: running ? 'idle' : value || 'idle',
      action: '1 回押す', ask: moved, key, busy: running, run: () => runServoTest(target),
      disabled: !!runningServo || !device.connected || device.voiceActive};
  }
  function checkGroups() {
    return [
      {title: 'つながり', rows: [diagnosticRow('usb', 'USB', '確認'), diagnosticRow('wifi', 'Wi-Fi', '確認'),
        diagnosticRow('api_https', 'サーバー', '確認'), diagnosticRow('api_wss', '音声の接続', '確認')]},
      {title: '音', rows: [micRow(), diagnosticRow('speaker', 'スピーカー', '鳴らす', heard), diagnosticRow('loopback', 'マイク → スピーカー', '録音して再生', heard)]},
      {title: 'サーボ', rows: ['c', 'e', 'u'].map(servoRow)},
      {title: '通しの確認', rows: [
        {name: 'チャイム', detail: mic?.model ? `登録済み / 検知 ${mic.detected} 回` : '未登録', status: mic?.detected ? 'ok' : 'idle', link: '#chime', action: '登録へ'},
        {name: 'テスト通話', detail: callCompleted(device.lines) ? '通話が最後まで終わった' : '未確認', status: callCompleted(device.lines) ? 'ok' : 'idle', link: '#call', action: '通話へ'},
      ]},
    ];
  }
  function renderCheck() {
    const groups = checkGroups();
    const rows = groups.flatMap(group => group.rows);
    const done = rows.filter(row => row.status === 'ok').length;
    $('#check-count').textContent = `${done} / ${rows.length}`;
    $('#check-progress').style.width = done * 100 / rows.length + '%';
    $('#check-all').disabled = !device.connected || !!diagnostics?.running;
    notice($('#check-notice'), device.recovery ? '通話の状態が不明です。インターホンを確かめてから本体をリセットしてください' : checkMessage);
    // Rebuilt only when something other than the live level changed, so a repaint
    // can never replace a button between press and release.
    const signature = JSON.stringify(rows.map(row => [row.name, row.meter === undefined ? row.detail : row.status, row.status, row.disabled, row.action]));
    if (signature !== checkSignature) {
      checkSignature = signature;
      buildCheck(groups);
    }
    const micNow = micRow();
    if (micDetail) micDetail.textContent = micNow.detail;
    if (micFill) micFill.style.width = micNow.meter + '%';
  }
  function buildCheck(groups) {
    const host = $('#check-groups');
    const focused = document.activeElement?.dataset?.control;
    host.replaceChildren(...groups.map(group => el('section', {className: 'card'},
      el('h2', {className: 'small', textContent: group.title}),
      ...group.rows.map(row => {
        const detail = el('div', {className: 'detail', textContent: row.detail});
        const text = el('div', {className: 'text'}, el('div', {className: 'name', textContent: row.name}), detail);
        if (row.meter !== undefined) {
          micDetail = detail;
          micFill = el('div');
          text.append(el('div', {className: 'meter', role: 'img', ariaLabel: 'マイクの音量'}, micFill));
        }
        const node = el('div', {className: 'row'}, text);
        const button = (label, onclick, filled, id) => {
          const b = el('button', {type: 'button', className: 'small-button' + (filled ? ' filled' : ''), textContent: label, onclick});
          b.dataset.control = id;
          return b;
        };
        if (row.status === 'ok') node.append(el('span', {className: 'ok', textContent: 'OK'}));
        if (row.status === 'ng') node.append(el('span', {className: 'ng', textContent: 'NG'}));
        if (row.status === 'ask') {
          node.append(button(row.ask[0], () => setAnswer(row.key, 'ok'), true, row.key + '-yes'), button(row.ask[1], () => setAnswer(row.key, 'ng'), false, row.key + '-no'));
        } else if (row.link) {
          node.append(el('a', {className: 'small-button', href: row.link, textContent: row.action}));
        } else if (row.action) {
          const b = button(row.action, row.run, false, row.key + '-run');
          b.disabled = row.disabled;
          node.append(b);
        }
        return node;
      }))));
    if (focused) host.querySelector(`[data-control="${focused}"]`)?.focus();
  }

  // --- Servo page
  const editor = new ServoEditor(api, sleep, () => { if (page === 'servo') renderServo(); });
  let servoTarget = 'c';
  const servoTabs = new Map();
  ['c', 'e', 'u'].forEach(target => {
    const button = el('button', {type: 'button', role: 'tab', onclick: () => { servoTarget = target; buildServoControls(); renderServo(); }},
      el('b', {textContent: servoNames[target]}), el('span', {textContent: servoPins[target]}));
    servoTabs.set(target, button);
    $('#servo-tabs').append(button);
  });
  const holdField = {c: 'call_hold_ms', e: 'end_hold_ms', u: 'unlock_hold_ms'};
  let servoControls = [];
  function angleControl(key, label) {
    return {label, min: 0, max: 180, step: 1, text: value => value + '°', minusLabel: label + 'を 1° 減らす', plusLabel: label + 'を 1° 増やす',
      read: () => editor.values[servoTarget][key],
      write: value => editor.setAngleLocal(servoTarget, key, value),
      commit: () => editor.commitAngle(servoTarget, key)};
  }
  function timeControl(field, label, min, max) {
    return {label, min, max, step: 100, text: value => (value / 1000).toFixed(1) + ' 秒', minusLabel: label + 'を短く', plusLabel: label + 'を長く',
      read: () => editor.values[field], write: value => editor.setTimingLocal(field, value), commit: () => editor.commitTiming(field)};
  }
  function buildServoControls() {
    if (!editor.values) return;
    servoControls = [angleControl('rest', '待機位置'), angleControl('press', '押す位置'),
      timeControl(holdField[servoTarget], '押す時間', 100, 2000), timeControl('return_ms', '戻す時間', 100, 3000)];
    if (servoTarget === 'c') servoControls.push(timeControl('call_delay_ms', '押す前の待ち時間', 0, 30000));
    $('#servo-controls').replaceChildren(...servoControls.map((control, index) => {
      const id = 'servo-control-' + index;
      const range = el('input', {id, type: 'range', min: control.min, max: control.max, step: control.step});
      const output = el('output', {htmlFor: id});
      let timer;
      const nudge = sign => {
        control.write(clamp(control.read() + sign * control.step, control.min, control.max));
        clearTimeout(timer);
        timer = setTimeout(() => control.commit(), 300); // repeated taps send one preview
      };
      range.oninput = () => control.write(Number(range.value));
      range.onchange = () => control.commit();
      control.range = range; control.output = output;
      return el('div', {className: 'control'},
        el('div', {className: 'top'},
          el('label', {htmlFor: id, textContent: control.label}),
          el('button', {type: 'button', className: 'step', textContent: '−', ariaLabel: control.minusLabel, onclick: () => nudge(-1)}),
          output,
          el('button', {type: 'button', className: 'step', textContent: '＋', ariaLabel: control.plusLabel, onclick: () => nudge(1)})),
        range);
    }));
  }
  function gaugePoint(line, degrees) {
    const angle = Math.PI * (1 - degrees / 180);
    line.setAttribute('x2', Math.round(160 + 118 * Math.cos(angle)));
    line.setAttribute('y2', Math.round(160 - 118 * Math.sin(angle)));
  }
  function renderServo() {
    if (!editor.values) return;
    if (!servoControls.length) buildServoControls();
    servoTabs.forEach((button, target) => button.setAttribute('aria-selected', String(target === servoTarget)));
    const {rest, press} = editor.values[servoTarget];
    gaugePoint($('#gauge-rest'), rest);
    gaugePoint($('#gauge-press'), press);
    $('#servo-gauge').setAttribute('aria-label', `待機 ${rest} 度、押す位置 ${press} 度`);
    $('#servo-rest').textContent = rest;
    $('#servo-press').textContent = press;
    $('#servo-travel').textContent = Math.abs(press - rest);
    servoControls.forEach(control => {
      const value = control.read();
      if (document.activeElement !== control.range || Number(control.range.value) !== value) control.range.value = value;
      control.output.textContent = control.text(value);
    });
    const test = $('#servo-test');
    test.textContent = editor.testing ? 'テストを止める' : servoNames[servoTarget] + 'を 1 回押す';
    test.disabled = !device.connected || device.voiceActive || (!editor.testing && !editor.canTest());
    $('#servo-mirror').disabled = !device.connected || device.voiceActive || !editor.canTest();
    $('#servo-state').textContent = editor.dirty ? '未保存' : '保存済み';
    $('#servo-save').disabled = !editor.dirty || !device.connected;
    $('#servo-undo').disabled = !editor.dirty;
    notice($('#servo-notice'), editor.message || (editor.motionError ? errorText(editor.motionError) : ''));
  }
  $('#servo-test').onclick = () => editor.testing ? editor.stopTest() : editor.test(servoTarget);
  $('#servo-mirror').onclick = () => editor.mirror(servoTarget);
  $('#servo-save').onclick = () => editor.save();
  $('#servo-undo').onclick = () => editor.undo();

  // --- Audio page
  function bindTune(id, field, valueKey) {
    const input = document.getElementById(id);
    input.oninput = () => { if (tune) { tune[valueKey] = Number(input.value); renderAudio(); } };
    input.onchange = async () => {
      try { tune = await api('tune', {field, value: Number(input.value)}); $('#audio-state').textContent = '保存済み'; }
      catch (error) { $('#audio-state').textContent = errorText(error.code || error.message); }
      renderAudio();
    };
  }
  bindTune('gate', 'gate', 'voice_rms_gate');
  bindTune('volume', 'volume', 'speaker_volume');
  bindTune('margin', 'margin', 'chime_margin');
  $('#audio-tone').onclick = () => runDiagnostic('speaker');
  $('#audio-loop').onclick = () => runDiagnostic('loopback');
  function renderAudio() {
    const rms = mic ? Math.round(mic.rms) : 0;
    const gate = tune?.voice_rms_gate ?? 600;
    const gateMax = Math.max(3000, gate);
    const percent = value => clamp(value * 100 / gateMax, 0, 100);
    $('#mic-level').textContent = rms;
    $('#mic-speech').textContent = rms >= gate ? '声として検出' : '無音';
    $('#mic-fill').style.width = percent(rms) + '%';
    $('#mic-mark').style.left = percent(gate) + '%';
    $('#mic-scale').setAttribute('aria-label', `音量 ${rms}、話し始めの音量 ${gate}`);
    const set = (id, value, text) => {
      const input = document.getElementById(id);
      if (Number(input.value) !== value) input.value = value;
      document.getElementById(id + '-value').textContent = text;
    };
    $('#gate').max = gateMax;
    if (tune) {
      set('gate', gate, String(gate));
      set('volume', tune.speaker_volume, tune.speaker_volume + '%');
      set('margin', tune.chime_margin, tune.chime_margin + '%');
    }
    const running = !!diagnostics?.running;
    $('#audio-tone').disabled = running || !device.connected || device.voiceActive;
    $('#audio-loop').disabled = running || !device.connected || device.voiceActive;
    const scale = value => clamp(value * 100 / 0.3, 0, 100);
    const threshold = mic?.model ? mic.threshold : null;
    const limit = threshold === null ? null : threshold * (tune?.chime_margin ?? 100) / 100;
    const score = mic && mic.last_score >= 0 ? mic.last_score : null;
    $('#limit-fill').style.width = (limit === null ? 0 : scale(limit)) + '%';
    $('#limit-value').textContent = limit === null ? '-' : limit.toFixed(3);
    $('#score-value').textContent = score === null ? '-' : score.toFixed(3);
    $('#score-mark').hidden = score === null;
    if (score !== null) $('#score-mark').style.left = scale(score) + '%';
    $('#score-scale').setAttribute('aria-label', `直近の距離 ${score === null ? 'なし' : score.toFixed(3)}、判定の上限 ${limit === null ? 'なし' : limit.toFixed(3)}`);
    $('#score-verdict').textContent = limit === null ? '未登録' : score === null ? '未判定' : score <= limit ? 'チャイムと判定' : 'チャイムではないと判定';
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
  $('#chime-start').onclick = () => consoleCommand('e').catch(error => notice($('#chime-notice'), error.message));
  $('#chime-cancel').onclick = () => consoleCommand('x').catch(error => notice($('#chime-notice'), error.message));
  $('#chime-format').onclick = async () => {
    if (!confirm('保存領域を初期化します。')) return;
    try { await post('/api/format', {confirm: 'FORMAT_AUDIO_STORAGE'}); }
    catch (error) { notice($('#chime-notice'), error.message); }
  };
  function renderChime() {
    const {step, message} = chimeProgress(device.lines);
    const running = step >= 0 && step <= 4;
    const finished = step === 5;
    const needsFormat = mic?.storage === false;
    const registered = !!mic?.model;
    const [title, sub] = running || finished ? chimeScreens[step] : needsFormat ? ['保存領域が未初期化です', ''] : [registered ? '登録済み' : '未登録', ''];
    $('#chime-title').textContent = title;
    $('#chime-sub').textContent = sub;
    notice($('#chime-notice'), message);
    $('#chime-fill').style.width = (mic ? clamp(mic.rms * 100 / 3000, 0, 100) : 0) + '%';
    $('#chime-steps').replaceChildren(...chimeSteps.map((name, index) =>
      el('li', {className: finished || index < step ? 'done' : index === step ? 'now' : '', textContent: name})));
    const start = $('#chime-start');
    start.hidden = running || needsFormat;
    start.textContent = registered || finished ? '登録し直す' : '登録を始める';
    start.disabled = !device.connected || device.voiceActive;
    $('#chime-format').hidden = !needsFormat;
    $('#chime-format').disabled = !device.connected;
    $('#chime-cancel').hidden = !running;
    $('#chime-registered').textContent = registered ? '登録済み' : '未登録';
    $('#chime-detected').textContent = (mic?.detected ?? 0) + ' 回';
    const limit = registered ? (mic.threshold * (tune?.chime_margin ?? 100) / 100).toFixed(3) : '-';
    $('#chime-score').textContent = `${mic && mic.last_score >= 0 ? mic.last_score.toFixed(3) : '-'} / ${limit}`;
  }

  // --- Call page
  let conversationRevision = -1, conversation = null;
  $('#call-toggle').onclick = () => consoleCommand(device.voiceActive ? 'q' : 'c').catch(error => { $('#call-stage').textContent = error.message; });
  function renderCall() {
    const toggle = $('#call-toggle');
    toggle.textContent = device.voiceActive ? '通話を止める' : '通話を始める';
    toggle.disabled = !device.connected || device.recovery;
    $('#call-stage').textContent = device.recovery ? '通話の状態が不明です。インターホンを確かめてから本体をリセットしてください' : device.voiceActive ? device.stage : '待機中';
    const at = callProgress(device.lines);
    $('#call-steps').replaceChildren(...CALL_STEPS.map((name, index) =>
      el('li', {className: index < at ? 'done' : index === at ? 'now' : '', textContent: name})));
    const messages = conversation?.messages || [];
    const talk = $('#talk');
    if (talk.childElementCount !== messages.length) {
      talk.replaceChildren(...messages.map(message =>
        el('div', {className: 'bubble ' + message.speaker}, el('div', {textContent: message.text}))));
    }
    const log = $('#log');
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    if (log.childElementCount !== device.lines.length || log.lastChild?.textContent !== device.lines.at(-1)) {
      log.replaceChildren(...device.lines.slice(-300).map(text => el('div', {textContent: text})));
      if (atEnd) log.scrollTop = log.scrollHeight;
    }
  }

  function render() {
    const connection = $('#connection');
    connection.textContent = device.connected ? 'XIAO 接続中' : 'XIAO 未接続';
    if (page === 'check') renderCheck();
    if (page === 'servo') renderServo();
    if (page === 'audio') renderAudio();
    if (page === 'chime') renderChime();
    if (page === 'call') renderCall();
  }

  // --- Pollers. Each waits for its own request, so a slow board never piles them up.
  async function every(ms, step) {
    for (;;) {
      try { await step(); } catch { /* the connection state is shown by the log poller */ }
      await sleep(ms);
    }
  }
  every(1000, async () => {
    let data;
    try { data = await getJson('/api/logs?after=' + device.logAfter); }
    catch (error) { device.connected = false; render(); throw error; }
    if (data.epoch !== device.epoch) {
      device.epoch = data.epoch; device.lines = []; device.logAfter = 0;
      loadAnswers();
      data = await getJson('/api/logs?after=0');
    }
    device.connected = data.connected;
    device.voiceActive = data.voice_active;
    device.recovery = data.recovery_required;
    device.stage = data.stage;
    device.logAfter = data.next;
    device.lines.push(...data.lines.map(line => line.text));
    if (device.lines.length > 500) device.lines.splice(0, device.lines.length - 500);
    render();
  });
  every(1000, async () => {
    diagnostics = await getJson('/api/diagnostics');
    render();
  });
  every(500, async () => {
    if (!device.connected || !['check', 'audio', 'chime'].includes(page)) return;
    mic = await getJson('/api/mic');
    if (!tune) tune = await getJson('/api/tune');
    render();
  });
  every(1000, async () => {
    if (!device.connected || (page !== 'servo' && editor.values)) return;
    editor.apply(await getJson('/api/state'));
  });
  every(1500, async () => {
    if (page !== 'call') return;
    const data = await getJson('/api/conversations?after=' + conversationRevision);
    if (data.changed) { conversationRevision = data.revision; conversation = data.session; render(); }
  });
  window.addEventListener('hashchange', showPage);
  showPage();
})();
