// The bench page in a real browser, against the real firmware code behind `run.sh bench`:
// real clicks, real rendering, and no errors in the console from start to finish.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const [url, failureShot] = process.argv.slice(2);
const SLOW = 40000;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(SLOW);
// XIAO_BROWSER_THROTTLE=8 slows the page's CPU, to see on a fast machine what a slow CI runner does.
if (process.env.XIAO_BROWSER_THROTTLE) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.XIAO_BROWSER_THROTTLE) });
}
const problems = [];
page.on('pageerror', error => problems.push('page error: ' + error.message));
page.on('console', message => { if (message.type() === 'error') problems.push('console: ' + message.text()); });

const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
const visible = text => page.getByText(text, { exact: true }).first().waitFor();
const go = async name => { await page.getByRole('menuitem', { name, exact: true }).click(); };
const logs = async () => (await (await page.request.get(url + '/api/logs?after=0')).json()).lines.map(line => line.text);
const count = async text => (await logs()).filter(line => line.includes(text)).length;
// Waits for a line that was not there yet: pass count(text) from before the action.
async function logged(text, before) {
  const deadline = Date.now() + SLOW;
  for (;;) {
    if ((await count(text)) > before) return;
    assert.ok(Date.now() < deadline, 'the board never logged: ' + text);
    await page.waitForTimeout(100);
  }
}
async function pick(index, option) {
  await page.locator('.ant-select').nth(index).click();
  await page.locator('.ant-select-item-option', { hasText: option }).click();
}
// What the 3D canvas really shows, from its pixels: a blank or failed WebGL canvas has one colour.
const canvasShot = () => page.locator('.scene canvas').screenshot();
async function pixels(shot) {
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const seen = new Set();
    let orange = 0, black = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      seen.add(r << 16 | g << 8 | b);
      if (r > 190 && g > 80 && g < 170 && b < 110) orange++;
      if (r < 70 && g < 70 && b < 70) black++;
    }
    return { colours: seen.size, orange, black };
  }, shot.toString('base64'));
}
async function modelIsDrawn(where) {
  const deadline = Date.now() + SLOW;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = (await pixels(await canvasShot())).colours;
    if (seen > 200) return;
    await page.waitForTimeout(300);
  }
  assert.fail(`${where}: the 3D model is not drawn (${seen} colours)`);
}
// Printed parts on the model: the bird is orange, and the black capsule leaves none and adds black.
async function partsOf(where, wanted) {
  const deadline = Date.now() + SLOW;
  let seen;
  while (Date.now() < deadline) {
    seen = await pixels(await canvasShot());
    if (wanted(seen)) return seen;
    await page.waitForTimeout(300);
  }
  assert.fail(`${where}: the printed parts are not what was chosen: ${JSON.stringify(seen)}`);
}
const step = name => console.log('browser: ' + name);

try {
  await page.goto(url);
  await button('チャイムを鳴らす').waitFor();
  await visible('bench 接続中');
  await modelIsDrawn('first load');
  const birdParts = await partsOf('bird', seen => seen.orange > 1500);
  step('page loads from the bench, 3D drawn');

  const names = ['仮想ボード', 'テスト', '動作確認', 'サーボ', '音', 'チャイム', 'テスト通話'];
  const titles = { テスト: 'テスト', 動作確認: '動作確認', サーボ: 'サーボ調整', 音: '音の調整', チャイム: 'チャイム登録', テスト通話: 'テスト通話' };
  for (const name of names) {
    await go(name);
    if (titles[name]) await page.getByRole('heading', { name: titles[name], exact: true }).waitFor();
    await page.locator('.scene canvas').waitFor();
  }
  await modelIsDrawn('after moving through the screens');
  step('all seven screens open, 3D stays on every one');

  // The two menus and the measured values.
  await pick(0, 'dearis');
  await visible('当たる所はありません');
  await pick(0, 'VS-MGE20');
  await pick(1, 'マット黒');
  await modelIsDrawn('matte capsule');
  await partsOf('matte capsule', seen => seen.orange < 100 && seen.black > birdParts.black + 1000);
  await pick(0, 'VL-WD623');
  await page.getByText('重なります', { exact: false }).waitFor();
  await pick(0, 'VS-MGE20');
  await page.getByText('充電台に約 6.9 mm', { exact: false }).waitFor();
  await button('寸法とキー位置を変える').click();
  const onKey = page.getByText('通話キーに載るラックは', { exact: false });
  const asTabled = await onKey.textContent();
  await page.getByLabel('通話キー 上下 mm').fill('-30');
  await visible('実測値で表示しています');
  await page.getByText('通話キーに載るラックは 13%').waitFor(); // the two keys now share one row, so the fit changed
  assert.notEqual(asTabled, await onKey.textContent());
  await page.reload();
  await visible('bench 接続中');
  await page.getByText('Panasonic VS-MGE20', { exact: false }).first().waitFor();
  await page.getByText('カプセル マット黒').first().waitFor();
  await visible('実測値で表示しています');
  await button('寸法とキー位置を変える').click();
  await button('表の値に戻す').click();
  await visible('外形は公開値、キー位置は推定です');
  await pick(1, '小鳥');
  step('intercom and exterior menus, measured values, kept across a reload');

  // Check screen: the board answers.
  await go('動作確認');
  await button('通信をまとめて確認').click();
  const row = name => page.locator('.row').filter({ has: page.getByText(name, { exact: true }) });
  await row('USB').getByText('OK').waitFor();
  await row('音声の接続').getByText('OK').waitFor();
  await button('鳴らす', row('スピーカー')).click();
  await button('聞こえた', row('スピーカー')).click();
  await row('スピーカー').getByText('OK').waitFor();
  await logged('[DIAG] speaker ok=1', 0);
  await button('1 回押す', row('プッシャー2（終話）')).click();
  await logged('[SERVO] END press once', 0);
  await button('動いた', row('プッシャー2（終話）')).click();
  await row('プッシャー2（終話）').getByText('OK').waitFor();
  step('check screen: connections, speaker and servo through the board');

  // Servo screen: reach from the real angles, a real press, editing and undo.
  await go('サーボ');
  await page.getByText('角度どおりに回れば、ラックは 2.4 mm 動きます。', { exact: false }).waitFor();
  await page.getByText('実際の角度は実機で確かめてください', { exact: false }).waitFor();
  const presses = await count('[SERVO] CALL press once');
  await button('プッシャー1を 1 回押す').click();
  for (let i = 0; i < 100 && await count('[SERVO] CALL press once') === presses; ++i) await page.waitForTimeout(100);
  assert.equal(await count('[SERVO] CALL press once'), presses + 1, 'one press, once');
  await button('プッシャー1を 1 回押す').waitFor();
  await button('押す位置を 1° 減らす').click();
  await visible('未保存');
  await button('元に戻す').click(); // before the step button's delayed commit
  await visible('保存済み');
  await page.waitForTimeout(800);
  assert.equal((await logs()).filter(line => line.startsWith('[MODE] calibration=')).at(-1) ?? '[MODE] calibration=idle', '[MODE] calibration=idle', 'undo must end calibration');
  // Calibration pauses calls, and the call screens say so.
  await button('押す位置を 1° 減らす').click();
  await logged('[MODE] calibration=active', 0);
  const paused = 'サーボの調整中は通話が始まりません。サーボの画面で保存するか元に戻してください';
  await go('仮想ボード');
  await visible(paused);
  await go('サーボ');
  await button('元に戻す').click();
  await visible('保存済み');
  await go('仮想ボード');
  await page.getByText(paused).waitFor({ state: 'detached' });
  await go('サーボ');
  await page.getByRole('tab', { name: 'プッシャー3（GPIO 9）' }).click();
  await visible('この構成に解錠を押す部品はありません');
  step('servo screen: rack reach, press, edit, undo');

  // Audio screen.
  await go('音');
  await button('この音量で鳴らす').waitFor();
  await page.getByText('話し始めの音量').waitFor();
  step('audio screen');

  // Chime: the real matcher registers the scripted bell, starting from an empty store.
  await go('チャイム');
  await button('保存領域を初期化').click();
  await button('初期化').click();
  await button('登録を始める').click();
  await visible('チャイムを鳴らしてください'); // after 2 s of background
  await button('チャイムを鳴らす').click(); // once: no second ring and no verification
  await page.locator('.ant-card .sub').getByText('次に鳴らすと検知します', { exact: true }).waitFor({ timeout: 15000 });
  await visible('登録しました');
  step('chime registered by the firmware');

  // Another sound is judged and starts nothing.
  await go('仮想ボード');
  await button('違う音を鳴らす').click();
  await page.getByText('チャイムではないと判定', { exact: false }).waitFor();
  assert.equal(await count('[VOICE] Preparing streaming call'), 0);
  step('another sound is not the chime');

  // The chime starts the whole call, and the model follows it.
  await page.waitForTimeout(2500); // the other sound has finished
  const callPresses = await count('[SERVO] CALL press once'), endPresses = await count('[SERVO] END press once');
  const callsEnded = await count('[VOICE] Call ended;');
  // Record what the model itself does from here on, frame by frame.
  await page.evaluate(() => {
    window.seen = { talk: 0, end: 0, screens: {}, sounds: {} };
    const sample = () => {
      const pose = MonbanModel.scene.pose();
      seen.talk = Math.max(seen.talk, pose.talk);
      seen.end = Math.max(seen.end, pose.end);
      seen.screens[pose.screen] = true;
      if (pose.sound) seen.sounds[pose.sound] = true;
      requestAnimationFrame(sample);
    };
    sample();
  });
  await button('チャイムを鳴らす').click();
  await logged('[SERVO] CALL press once', callPresses);
  await page.locator('.scene .caption.ai').waitFor();
  await logged('[SERVO] END press once', endPresses);
  await logged('[VOICE] Call ended;', callsEnded);
  await button('チャイムを鳴らす').waitFor();
  assert.equal(await count('[SERVO] CALL press once'), callPresses + 1);
  assert.equal(await count('[SERVO] END press once'), endPresses + 1);
  await page.locator('.scene .caption').waitFor({ state: 'detached' });
  await page.waitForTimeout(1000); // the last release is drawn
  const seen = await page.evaluate(() => window.seen);
  assert.ok(seen.talk > 1.5, `the call rack never reached the key: ${JSON.stringify(seen)}`);
  assert.ok(seen.end > 1.5, `the end rack never reached the key: ${JSON.stringify(seen)}`);
  assert.ok(seen.screens.ringing && seen.screens.call && seen.screens.off, JSON.stringify(seen));
  assert.ok(seen.sounds.intercom && seen.sounds.device && seen.sounds.visitor, JSON.stringify(seen));
  const pose = await page.evaluate(() => MonbanModel.scene.pose());
  assert.deepEqual([pose.talk, pose.end, pose.screen, pose.sound], [0, 0, 'off', null], 'the model returned to rest');
  step('chime to call to end, with the model following');

  // Test call, stopped part way.
  await logged('[VOICE] Call cooldown complete;', 0);
  await go('テスト通話');
  await button('通話を始める').click();
  await button('通話を止める').click();
  await logged('Call stopped;', 0);
  await button('通話を始める').waitFor();
  step('test call starts and stops');

  // Test screen: a real run, stopped.
  await go('テスト');
  await page.getByText('実機が届くまで確かめられない').waitFor();
  const first = page.locator('.row').filter({ has: page.getByText('各部のテスト', { exact: true }) });
  await button('実行', first).click();
  await first.getByText('実行中').waitFor();
  await page.getByText('--- audio', { exact: false }).waitFor();
  await button('止める').click();
  await first.getByText('止めました').waitFor();
  step('test screen runs and stops a suite');

  // Narrow window: nothing runs off the side.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['動作確認', 'サーボ']) {
    await page.goto(url + '/#' + { 動作確認: 'check', サーボ: 'servo' }[name]);
    await page.locator('.scene canvas').waitFor();
    // antd measures its menu and tabs after the first paint, so judge the settled layout.
    await page.waitForTimeout(1500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `${name}: ${over} px wider than the window`);
  }
  step('narrow window');

  assert.deepEqual(problems, [], 'errors in the browser');
  console.log('PASS: bench page in a real browser');
} catch (error) {
  await page.screenshot({ path: failureShot, fullPage: true }).catch(() => {});
  console.error(error);
  if (problems.length) console.error(problems.join('\n'));
  console.error('Last board lines:\n' + (await logs().catch(() => [])).slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
