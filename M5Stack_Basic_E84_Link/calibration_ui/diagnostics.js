(() => {
 const container=document.querySelector('#diagnostic-checks'),banner=document.querySelector('#diagnostic-status');
 const rows=new Map(),network=new Set(['m5_udp','m5_tcp','api_https','api_wss']);
 const buttons={m5_usb:'M5 USBを確認',e84_usb:'E84 USBを確認',m5_wifi:'M5 Wi-Fiを確認',e84_wifi:'E84 Wi-Fiを確認',m5_udp:'UDP疎通を確認',m5_tcp:'音声用TCPを確認',api_https:'HTTPS APIを確認',api_wss:'音声用APIを確認'};
 const labels={idle:'未確認',running:'確認中',ok:'成功',failed:'失敗',blocked:'実行できません',warning:'一部未準備',stale:'要再確認'};
 let latest=null,starting=false;
 function element(tag,className,text){const node=document.createElement(tag);node.className=className;node.textContent=text;return node}
 function render(data){
  if(latest&&data.epoch===latest.epoch&&data.revision<latest.revision)return;
  latest=data;
  for(const [key,result]of Object.entries(data.results)){
   let row=rows.get(key);
   if(!row){
    const card=element('article','diagnostic-item',''),head=element('div','diagnostic-head','');
    const title=element('h3','',result.label),state=element('span','diagnostic-state','');
    const description=element('p','note',result.description),detail=element('p','diagnostic-detail',''),time=element('p','note diagnostic-time','');
    const button=element('button','',buttons[key]||'確認する');button.type='button';button.dataset.diagnostic=key;button.onclick=()=>start(key);
    head.append(title,state);card.append(head,description,button,detail,time);container.append(card);
    row={state,detail,time,button};rows.set(key,row);
   }
   const age=result.checked_at?Math.max(0,(Date.now()-Date.parse(result.checked_at))/1000):null;
   const state=result.state==='ok'&&age>=60?'stale':result.state;
   row.state.textContent=labels[state]||'未確認';row.state.className='diagnostic-state '+state;
   row.detail.textContent=result.detail+(state==='stale'?' 前回の成功です。現在の状態は再確認してください。':'');
   row.time.textContent=result.checked_at?'確認時刻 '+new Date(result.checked_at).toLocaleTimeString('ja-JP')+' ／ 診断所要 '+(result.duration_ms/1000).toFixed(1)+'秒':'';
   row.button.disabled=starting||!!data.running||(data.voice_active&&network.has(key));
   row.button.title=data.voice_active&&network.has(key)?'通話終了後に確認してください。':'';
  }
  banner.textContent=data.running?data.results[data.running].label+'：診断中です。':data.recovery_required&&!data.voice_active?'通話は復旧待ちです。通信診断は実行できます。通話を再開する前に本体の状態を確認して再起動してください。':'確認したい通信のボタンを押してください。';
 }
 async function start(target){
  if(starting||latest?.running)return;
  starting=true;if(latest)render(latest);
  try{
   const response=await fetch('/api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target})});
   const data=await response.json();if(!data.ok)throw Error(data.error);
   starting=false;render(data);
  }catch(error){starting=false;if(latest)render(latest);banner.textContent=error.message;}
 }
 async function poll(){
  try{const response=await fetch('/api/diagnostics'),data=await response.json();if(!data.ok)throw Error(data.error);render(data)}
  catch(error){banner.textContent='通信診断への接続エラー：'+error.message;for(const row of rows.values())row.button.disabled=true;}
  finally{setTimeout(poll,1000)}
 }
 poll();
})();
