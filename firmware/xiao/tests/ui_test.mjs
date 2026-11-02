import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Exercise the actual UI handler with an API that rejects a busy receiver.
// A test operation may never be retried/queued as if it were a state read.
const html=readFileSync(new URL('../calibration_ui/index.html',import.meta.url),'utf8');
const start=html.indexOf('async function testButton(target)');
const end=html.indexOf("$('#stop-test').onclick",start);
assert(start>=0 && end>start);
function fixture(overrides={}) {
  const requests=[],messages=[];
  const context=vm.createContext({
    busy:false,testRunning:false,motionBusy:false,moving:false,pending:new Map(),
    testCancelled:false,testPoll:null,debounce:null,pendingError:null,
    targetNames:{c:'通話',e:'終了',u:'解錠'},
    controls(){},message(text){messages.push(text)},async pump(){},async sleep(){},
    clearTimeout(){},setTimeout(){return 1},pollTest(){},apply(){},
    async api(action,body){requests.push({action,body});return {ok:true,test_busy:true}},
    ...overrides,
  });
  vm.runInContext(html.slice(start,end),context);
  return {context,requests,messages};
}
for(const target of ['c','e','u']) {
  for(const blocked of [{motionBusy:true},{moving:true},{pending:new Map([['end_press',{}]])}]) {
    const {context,requests}=fixture(blocked);
    await context.testButton(target);
    assert.equal(requests.length,0,'preview must not queue a test press');
  }
  {
    let attempts=0;
    const {context,messages}=fixture({async api(){
      attempts++;const e=new Error('receiver_busy');e.code='receiver_busy';throw e;
    }});
    await context.testButton(target);
    assert.equal(attempts,1,'a rejected test must not be replayed later');
    assert.equal(context.busy,false);
    assert(messages.includes('receiver_busy'));
  }
  {
    const {context,requests}=fixture();
    await context.testButton(target);
    assert.equal(requests.length,1);
    assert.equal(requests[0].action,'test');
    assert.equal(requests[0].body.target,target);
  }
}
{
  const {context,messages}=fixture();
  await context.testButton('u');
  assert(messages.some(text=>text.startsWith('解錠ボタン')));
}
console.log('Web UI: no queued/retried test press behind a preview passed');

// One board: the page names XIAO pins and has no controls for the removed link.
for(const badge of ['GPIO 7 (D8)','GPIO 8 (D9)','GPIO 9 (D10)'])assert(html.includes(badge),badge);
assert(html.includes("['unlock','u']"),'unlock servo has rest/press sliders');
assert(html.includes("['unlock','u','解錠ボタンを1回押す']"),'unlock servo has a test button');
assert(html.includes("['unlock_hold_ms','unlock',"),'unlock hold timing');
assert(html.includes('<button data-console="e">'));
assert(html.includes('<button data-console="x">'));
assert(!html.includes('チャイム検知を再待機'));
const diagnostics=readFileSync(new URL('../calibration_ui/diagnostics.js',import.meta.url),'utf8');
for(const removed of [/M5/,/E84/,/board-link/,/board_link/,/UDP/,/data-console="[tv]"/,/FORMAT_AUDIO_STORAGE/]){
  assert(!removed.test(html),'index.html: '+removed);
  assert(!removed.test(diagnostics),'diagnostics.js: '+removed);
}
console.log('Web UI: XIAO pins, unlock servo, enrollment buttons and no link concepts passed');
