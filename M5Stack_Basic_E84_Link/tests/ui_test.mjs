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
    controls(){},message(text){messages.push(text)},async pump(){},async sleep(){},
    clearTimeout(){},setTimeout(){return 1},pollTest(){},apply(){},
    async api(action,body){requests.push({action,body});return {ok:true,test_busy:true}},
    ...overrides,
  });
  vm.runInContext(html.slice(start,end),context);
  return {context,requests,messages};
}
for(const blocked of [{motionBusy:true},{moving:true},{pending:new Map([['end_press',{}]])}]) {
  const {context,requests}=fixture(blocked);
  await context.testButton('e');
  assert.equal(requests.length,0,'preview must not queue an END test');
}
{
  let attempts=0;
  const {context,messages}=fixture({async api(){
    attempts++;const e=new Error('receiver_busy');e.code='receiver_busy';throw e;
  }});
  await context.testButton('e');
  assert.equal(attempts,1,'a rejected END test must not be replayed later');
  assert.equal(context.busy,false);
  assert(messages.includes('receiver_busy'));
}
{
  const {context,requests}=fixture();
  await context.testButton('e');
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,'test');
  assert.equal(requests[0].body.target,'e');
}
console.log('Web UI: no queued/retried END press behind a preview passed');
