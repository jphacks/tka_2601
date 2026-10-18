import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../calibration_ui/diagnostics.js',import.meta.url),'utf8');
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.textContent='';this.disabled=false}
 append(...nodes){this.children.push(...nodes)}
}
const container=new Element('div'),banner=new Element('p'),requests=[],timers=[];
const keys=['m5_usb','e84_usb','m5_wifi','e84_wifi','m5_udp','m5_tcp','api_https','api_wss'];
let data={ok:true,epoch:'first',revision:0,running:null,voice_active:false,results:Object.fromEntries(keys.map(key=>[key,{label:key,description:key,state:'idle',detail:'未確認',checked_at:null,duration_ms:null}]))};
const context=vm.createContext({document:{querySelector:selector=>selector==='#diagnostic-checks'?container:banner,createElement:tag=>new Element(tag)},Date,
 setTimeout:callback=>timers.push(callback),
 async fetch(path,options){requests.push({path,options});return {async json(){return structuredClone(data)}}},
});
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve))};
vm.runInContext(source,context);await flush();
assert.equal(container.children.length,8);
const cards=new Map(container.children.map(card=>[card.children[2].dataset.diagnostic,card]));
assert.equal(cards.get('m5_usb').children[2].textContent,'M5 USBを確認');
data={...data,revision:1,running:'api_wss'};
data.results.api_wss={...data.results.api_wss,state:'running',detail:'確認中'};
await cards.get('api_wss').children[2].onclick();await flush();
assert.equal(JSON.parse(requests.at(-1).options.body).target,'api_wss');
assert([...cards.values()].every(card=>card.children[2].disabled));
data={...data,revision:2,running:null,voice_active:true};
data.results.api_wss={...data.results.api_wss,state:'ok',detail:'成功',checked_at:new Date(Date.now()-61000).toISOString(),duration_ms:500};
await timers.shift()();await flush();
assert.equal(cards.get('api_wss').children[0].children[1].textContent,'要再確認');
assert.equal(cards.get('m5_usb').children[2].disabled,false);
assert.equal(cards.get('m5_tcp').children[2].disabled,true);
data={...data,revision:0,voice_active:false};
await timers.shift()();await flush();
assert.equal(cards.get('m5_tcp').children[2].disabled,true,'ignore out-of-order poll');
data={...data,epoch:'restarted',revision:0,voice_active:false};
await timers.shift()();await flush();
assert.equal(cards.get('m5_tcp').children[2].disabled,false,'recover after server restart');
console.log('Diagnostics UI: eight buttons, isolated requests, busy/call guard, stale and restart handling passed');

data={...data,revision:1,voice_active:false,recovery_required:true};
await timers.shift()();await flush();
assert([...cards.values()].every(card=>!card.children[2].disabled));
assert(banner.textContent.includes('復旧待ち') && banner.textContent.includes('通信診断は実行できます'));
