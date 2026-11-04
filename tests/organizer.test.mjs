import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGroups, undoGroups } from '../extension/organizer.js';
import { DEFAULTS, eligibleTabs, fingerprint } from '../extension/core.js';
function fixture() {
  const tabs=[{id:1,title:'GitHub',url:'https://github.com',index:0,windowId:1,groupId:-1},{id:2,title:'Python',url:'https://python.org',index:1,windowId:1,groupId:-1},{id:3,title:'Existing',url:'https://existing.test',index:2,windowId:1,groupId:99}];
  const calls=[];
  const api={tabs:{query:async()=>tabs, get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t;},group:async({tabIds})=>{calls.push(['group',tabIds]);for(const t of tabs)if(tabIds.includes(t.id))t.groupId=8;return 8;},ungroup:async ids=>{calls.push(['ungroup',ids]);for(const t of tabs)if(ids.includes(t.id))t.groupId=-1;},move:async(id,options)=>calls.push(['move',id,options])},tabGroups:{update:async(...args)=>calls.push(['update',...args])}};
  const preview={windowId:1,createdAt:Date.now(),fingerprint:fingerprint(eligibleTabs(tabs,DEFAULTS)),groups:[{title:'Dev',color:'blue',tabIds:[1,2]}]};
  return {tabs,calls,api,preview};
}
test('persist undo before mutating and apply only previewed groups',async()=>{
  const f=fixture();let undo;
  await applyGroups(f.api,f.preview,DEFAULTS,async value=>{if(!undo)assert.equal(f.calls.length,0);undo=structuredClone(value);});
  assert.deepEqual(undo.createdGroupIds,[8]);assert.equal(f.tabs[2].groupId,99);assert.deepEqual(undo.affected,[1,2]);
  await undoGroups(f.api,undo);assert.deepEqual(f.calls.filter(c=>c[0]==='ungroup').flatMap(c=>c[1]),[1,2]);assert.equal(f.tabs[2].groupId,99);
});
test('stale preview fails before any changes',async()=>{
  const f=fixture();f.tabs[0].title='Changed';
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,()=>assert.fail('no snapshot')),/重新/);assert.equal(f.calls.length,0);
});
test('expired preview fails before changes',async()=>{
  const f=fixture();f.preview.createdAt=0;
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,()=>{}));assert.equal(f.calls.length,0);
});
test('partial failure keeps a usable undo snapshot',async()=>{
  const f=fixture();let undo;f.api.tabGroups.update=async()=>{throw Error('failure');};
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,async value=>{undo=structuredClone(value);}),/撤销/);
  assert.deepEqual(undo.createdGroupIds,[8]);await undoGroups(f.api,undo);assert.equal(f.tabs[0].groupId,-1);
});
test('undo does not ungroup manually regrouped tabs or recreate closed tabs',async()=>{
  const f=fixture();let undo;await applyGroups(f.api,f.preview,DEFAULTS,async value=>{undo=structuredClone(value);});
  f.tabs[0].groupId=123;f.tabs.splice(1,1);
  await undoGroups(f.api,undo);assert.equal(f.tabs[0].groupId,123);assert.ok(!f.calls.some(c=>c[0]==='ungroup'));
});
test('navigation to an excluded domain between query and get aborts grouping',async()=>{
  const f=fixture();const original=f.api.tabs.get;f.api.tabs.get=async id=>({...await original(id),url:'https://excluded.test/'});
  await assert.rejects(applyGroups(f.api,f.preview,{...DEFAULTS,excludedDomains:'excluded.test'},async()=>{}));
  assert.ok(!f.calls.some(c=>c[0]==='group'));
});
test('undo reconciles group creation if saving returned group ID fails',async()=>{
  const f=fixture();let stored;let count=0;
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,async value=>{count++;if(count===3)throw Error('storage failed');stored=structuredClone(value);}));
  assert.equal(stored.phase,'applying');assert.deepEqual(stored.pending,{tabIds:[1,2],targetGroupId:null});assert.equal(f.tabs[0].groupId,8);
  const result=await undoGroups(f.api,stored);assert.equal(result.tabs,2);assert.equal(f.tabs[0].groupId,-1);
});
test('interrupted recovery reports unresolved membership changes',async()=>{
  const f=fixture();let stored;let count=0;
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,async value=>{if(++count===3)throw Error('failure');stored=structuredClone(value);}));
  f.tabs.push({id:4,index:3,groupId:8,windowId:1});
  const result=await undoGroups(f.api,stored);assert.equal(result.unresolved,true);assert.equal(result.tabs,0);
});
