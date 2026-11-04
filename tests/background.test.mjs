import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, apiEndpoint } from '../extension/core.js';
function store(initial={}) {
  const values=structuredClone(initial);
  return {values,setAccessLevel:async()=>{},get:async keys=>keys==null?structuredClone(values):Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in values).map(k=>[k,structuredClone(values[k])])),set:async data=>{Object.assign(values,structuredClone(data));},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete values[key];}};
}
async function setup(initialLocal={}) {
  const settings={...DEFAULTS,provider:'api',consent:true};
  const event=()=>({addListener(fn){this.listener=fn;}});
  const chrome={storage:{session:store(),local:store({settings,...initialLocal})},runtime:{id:'test',getURL:()=> 'chrome-extension://test/',onMessage:event(),onStartup:event(),onInstalled:event()},permissions:{contains:async()=>true},alarms:{get:async()=>null,create:async()=>{},clear:async()=>{},onAlarm:event()},tabs:{query:async()=>[{id:1,title:'GitHub',url:'https://github.com',groupId:-1,index:0},{id:2,title:'Python',url:'https://python.org',groupId:-1,index:1}],onCreated:event(),onUpdated:event()},tabGroups:{query:async()=>[]},windows:{onRemoved:event()}};
  globalThis.chrome=chrome;
  await import(`../extension/background.js?test=${Math.random()}`);
  const message=data=>new Promise(resolve=>chrome.runtime.onMessage.listener(data,{id:'test',url:'chrome-extension://test/popup.html'},resolve));
  return {chrome,message,settings};
}
test('keys are bound to endpoints and interrupted settings cannot cross-send',async()=>{
  const f=await setup();const oldEndpoint=apiEndpoint(f.settings.baseUrl).endpoint;
  f.chrome.storage.session.values.credentials={key:'old-test-key',endpoint:oldEndpoint};
  const localSet=f.chrome.storage.local.set;
  f.chrome.storage.local.set=async()=>{throw Error('simulated storage failure');};
  const result=await f.message({type:'saveSettings',settings:{...f.settings,baseUrl:'https://api.example.test/v1'},apiKey:'new-test-key'});
  assert.equal(result.ok,false);
  assert.equal(f.chrome.storage.local.values.settings.baseUrl,f.settings.baseUrl);
  assert.equal(f.chrome.storage.session.values.credentials.endpoint,'https://api.example.test/v1/chat/completions');
  f.chrome.storage.local.set=localSet;
  const state=await f.message({type:'settings'});assert.equal(state.result.hasKey,false);
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('must not send unmatched key');
  try { const preview=await f.message({type:'preview',windowId:1});assert.equal(preview.ok,false);assert.match(preview.error,/Key/); }
  finally {globalThis.fetch=originalFetch;}
});
test('changing API endpoint does not reuse old credentials',async()=>{
  const f=await setup();f.chrome.storage.session.values.credentials={key:'old-test-key',endpoint:apiEndpoint(f.settings.baseUrl).endpoint};
  const result=await f.message({type:'saveSettings',settings:{...f.settings,baseUrl:'https://api.example.test/v1'}});
  assert.equal(result.ok,true);assert.equal(result.result.hasKey,false);assert.equal(f.chrome.storage.session.values.credentials,null);
});
test('incomplete recovery prevents applying another preview',async()=>{
  const f=await setup();f.chrome.storage.session.values['undo:1']={phase:'applying'};
  const result=await f.message({type:'apply',windowId:1});assert.equal(result.ok,false);assert.match(result.error,/先撤销/);
});
test('repeated preview requests share one in-flight API call',async()=>{
  const f=await setup();f.chrome.storage.session.values.credentials={key:'test-key',endpoint:apiEndpoint(f.settings.baseUrl).endpoint};
  const originalFetch=globalThis.fetch;let calls=0;let release;const gate=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async()=>{calls++;await gate;return new Response(JSON.stringify({choices:[{message:{content:'{"groups":[]}'}}]}));};
  try {const a=f.message({type:'preview',windowId:1});const b=f.message({type:'preview',windowId:1});await new Promise(r=>setImmediate(r));release();assert.equal((await a).ok,true);assert.equal((await b).ok,true);assert.equal(calls,1);}
  finally{globalThis.fetch=originalFetch;}
});

test('manual edits increment revision and stale panels cannot apply or overwrite',async()=>{
  const f=await setup();f.chrome.storage.local.values.settings={...DEFAULTS};
  const first=await f.message({type:'preview',windowId:1});assert.equal(first.ok,true);
  const value=first.result;const groups=[{title:'Renamed',color:'blue',tabIds:[1,2]}];
  const edit=await f.message({type:'editPreview',windowId:1,previewId:value.id,revision:0,groups});assert.equal(edit.ok,true);assert.equal(edit.result.revision,1);
  const staleEdit=await f.message({type:'editPreview',windowId:1,previewId:value.id,revision:0,groups});assert.equal(staleEdit.ok,false);
  const staleApply=await f.message({type:'apply',windowId:1,previewId:value.id,revision:0});assert.equal(staleApply.ok,false);
  assert.equal(f.chrome.storage.session.values['preview:1'].groups[0].title,'Renamed');
});
test('invalid edits never replace the saved preview',async()=>{
  const f=await setup();f.chrome.storage.local.values.settings={...DEFAULTS};
  const {result:value}=await f.message({type:'preview',windowId:1});
  for(const groups of [[{title:'One',tabIds:[1]}],[{targetGroupId:999,tabIds:[1]}],[{title:'Duplicate',tabIds:[1,1]}]]){
    const result=await f.message({type:'editPreview',windowId:1,previewId:value.id,revision:0,groups});assert.equal(result.ok,false);
  }
  assert.equal(f.chrome.storage.session.values['preview:1'].revision,0);
});
test('failed preview refresh removes the old actionable preview',async()=>{
  const f=await setup();f.chrome.storage.session.values['preview:1']={id:'old',groups:[{}]};
  const result=await f.message({type:'preview',windowId:1});assert.equal(result.ok,false);assert.equal(f.chrome.storage.session.values['preview:1'],undefined);
});
test('single unmatched tab creates an editable empty preview without invoking AI',async()=>{
  const f=await setup();const query=f.chrome.tabs.query;f.chrome.tabs.query=async()=>[...(await query()).slice(0,1)];
  const old=globalThis.fetch;globalThis.fetch=()=>assert.fail('no network');
  try{const result=await f.message({type:'preview',windowId:1});assert.equal(result.ok,true);assert.deepEqual(result.result.groups,[]);assert.equal(result.result.tabs.length,1);}finally{globalThis.fetch=old;}
});
test('automation leaves a recent manual preview and pending work untouched',async()=>{
  const f=await setup();f.chrome.storage.local.values.settings={...DEFAULTS,auto:true};
  const value=(await f.message({type:'preview',windowId:1})).result;
  f.chrome.storage.session.values['pending:1']={at:Date.now()-20_000};
  f.chrome.alarms.onAlarm.listener({name:'auto-organize'});await new Promise(resolve=>setImmediate(resolve));
  // Queue a read-modify message behind the alarm, so this assertion is not timing-dependent.
  await f.message({type:'editPreview',windowId:1,previewId:value.id,revision:0,groups:value.groups});
  assert.ok(f.chrome.storage.session.values['pending:1']);assert.equal(f.chrome.storage.session.values['preview:1'].id,value.id);assert.equal(f.chrome.storage.session.values['lastAuto:1'],undefined);
});

test('no-candidate or group-query failure also clears old previews',async()=>{
  for(const reason of ['empty','query']){
    const f=await setup();f.chrome.storage.session.values['preview:1']={id:'old'};
    if(reason==='empty')f.chrome.tabs.query=async()=>[];
    else f.chrome.tabGroups.query=async()=>{throw Error('query failed');};
    assert.equal((await f.message({type:'preview',windowId:1})).ok,false);assert.equal(f.chrome.storage.session.values['preview:1'],undefined);
  }
});

test('API keys are session-only and legacy persistent credentials are removed',async()=>{
  const f=await setup({credentials:{key:'legacy-test-placeholder',endpoint:'https://api.openai.com/v1/chat/completions'},apiKey:'legacy-unbound-placeholder'});
  const state=await f.message({type:'settings'});
  assert.equal(state.result.hasKey,false);
  assert.equal('credentials' in f.chrome.storage.local.values,false);
  assert.equal('apiKey' in f.chrome.storage.local.values,false);
  const saved=await f.message({type:'saveSettings',settings:{...f.settings,rememberKey:true},apiKey:'session-test-placeholder'});
  assert.equal(saved.ok,true);
  assert.equal(f.chrome.storage.session.values.credentials.key,'session-test-placeholder');
  assert.equal(f.chrome.storage.local.values.settings.rememberKey,false);
  assert.equal('credentials' in f.chrome.storage.local.values,false);
  assert.doesNotMatch(JSON.stringify(f.chrome.storage.local.values),/session-test-placeholder|legacy-test-placeholder/);
});
