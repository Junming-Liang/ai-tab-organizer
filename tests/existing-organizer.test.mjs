import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,eligibleTabs,fingerprint} from '../extension/core.js';
import {snapshotGroups} from '../extension/planning.js';
import {applyGroups,undoGroups} from '../extension/organizer.js';
function fixture() {
  const tabs=[
    {id:1,title:'GitHub new',url:'https://github.com/new',windowId:1,index:0,groupId:-1},
    {id:2,title:'Python new',url:'https://python.org/new',windowId:1,index:1,groupId:-1},
    {id:10,title:'Old project',url:'https://github.com/old',windowId:1,index:2,groupId:90},
    {id:11,title:'Old research',url:'https://arxiv.org/old',windowId:1,index:3,groupId:91},
    {id:12,title:'Unrelated',url:'https://unrelated.test',windowId:1,index:4,groupId:-1},
  ];
  const groups=[{id:90,windowId:1,title:'开发',color:'orange',collapsed:true},{id:91,windowId:1,title:'Research',color:'purple',collapsed:false}];
  const calls=[];let undo;let nextId=100;
  const api={tabs:{query:async()=>structuredClone(tabs),get:async id=>{const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('closed');return structuredClone(tab);},
    group:async options=>{calls.push(['group',structuredClone(options)]);const groupId=options.groupId??nextId++;if(options.groupId==null)groups.push({id:groupId,windowId:1,title:'',color:'grey',collapsed:false});for(const tab of tabs)if(options.tabIds.includes(tab.id))tab.groupId=groupId;return groupId;},
    ungroup:async ids=>{calls.push(['ungroup',ids]);for(const tab of tabs)if(ids.includes(tab.id))tab.groupId=-1;},move:async(id,options)=>calls.push(['move',id,options])},
    tabGroups:{query:async()=>structuredClone(groups.filter(group=>tabs.some(tab=>tab.groupId===group.id))),update:async(id,details)=>{calls.push(['update',id,details]);Object.assign(groups.find(group=>group.id===id),details);}}};
  const candidates=eligibleTabs(tabs,DEFAULTS);
  const preview={windowId:1,createdAt:Date.now(),tabs:candidates,fingerprint:fingerprint(candidates),existingGroups:snapshotGroups(groups,tabs,DEFAULTS,1),groups:[{title:'开发',color:'orange',targetGroupId:90,tabIds:[1]}]};
  const save=async value=>{undo=structuredClone(value);};
  return {tabs,groups,calls,api,preview,save,get undo(){return undo;}};
}
test('single new tab joins the existing ID without any group metadata mutation',async()=>{
  const f=fixture();const before=structuredClone(f.groups);
  const result=await applyGroups(f.api,f.preview,DEFAULTS,f.save);
  assert.equal(result.existing,1);assert.deepEqual(f.calls[0],['group',{groupId:90,tabIds:[1]}]);assert.deepEqual(f.groups,before);assert.deepEqual(f.undo.createdGroupIds,[]);
  const undone=await undoGroups(f.api,f.undo);assert.equal(undone.tabs,1);assert.equal(f.tabs[0].groupId,-1);assert.equal(f.tabs[2].groupId,90);assert.deepEqual(f.groups,before);
  assert.deepEqual(f.calls.filter(call=>call[0]==='move').map(call=>call[1]),[1]);
});
test('renamed, recolored, collapsed, moved, deleted or newly shared target rejects before persistence',async()=>{
  for(const mutation of [f=>f.groups[0].title='Changed',f=>f.groups[0].color='red',f=>f.groups[0].collapsed=false,f=>f.groups[0].windowId=2,f=>f.groups.splice(0,1),f=>f.groups[0].shared=true,f=>f.tabs[2].url='https://changed.example',f=>f.tabs.push({id:20,windowId:1,groupId:90,index:6})]) {
    const f=fixture();mutation(f);await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,()=>assert.fail('no undo written')),/重新/);assert.equal(f.calls.length,0);
  }
});
test('saving intent may yield; revalidate target and candidate after storage completes',async()=>{
  for(const mutation of [f=>f.groups[0].title='Changed',f=>f.tabs[0].groupId=91,f=>f.tabs[0].pinned=true,f=>f.tabs[0].windowId=2]) {
    const f=fixture();let count=0;
    await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,async undo=>{await f.save(undo);if(++count===2)mutation(f);}),/撤销/);
    assert.equal(f.calls.filter(call=>call[0]==='group').length,0);
  }
});
test('failure after existing-group mutation preserves precise pending destination',async()=>{
  const f=fixture();let count=0;
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,async undo=>{if(++count===3)throw Error('storage interrupted');await f.save(undo);}),/撤销/);
  assert.deepEqual(f.undo.pending,{targetGroupId:90,tabIds:[1]});assert.equal(f.tabs[0].groupId,90);
  f.tabs.push({id:20,windowId:1,index:6,groupId:90});
  const result=await undoGroups(f.api,f.undo);assert.equal(result.tabs,1);assert.equal(f.tabs[2].groupId,90);assert.equal(f.tabs.at(-1).groupId,90);
});
test('undo never pulls an added tab back from another existing group/window or pinned state',async()=>{
  for(const mutation of [f=>f.tabs[0].groupId=91,f=>f.tabs[0].windowId=2,f=>f.tabs[0].pinned=true,f=>f.tabs.splice(0,1)]) {
    const f=fixture();await applyGroups(f.api,f.preview,DEFAULTS,f.save);mutation(f);
    const result=await undoGroups(f.api,f.undo);assert.equal(result.tabs,0);assert.equal(f.calls.filter(call=>call[0]==='ungroup').length,0);
  }
});
test('mixed existing/new operations remain undoable and original groups unchanged',async()=>{
  const f=fixture();f.preview.groups.push({title:'New',color:'green',tabIds:[2,12]});
  await applyGroups(f.api,f.preview,DEFAULTS,f.save);assert.deepEqual(f.undo.createdGroupIds,[100]);assert.equal(f.undo.assignments.length,2);
  assert.equal(f.calls.filter(call=>call[0]==='update').length,1);
  const result=await undoGroups(f.api,f.undo);assert.equal(result.tabs,3);assert.equal(f.tabs[2].groupId,90);assert.equal(f.tabs[3].groupId,91);
});
test('each recorded destination is respected even between newly created groups',async()=>{
  const f=fixture();f.preview.groups=[{title:'New one',color:'blue',tabIds:[1,2]}];
  await applyGroups(f.api,f.preview,DEFAULTS,f.save);
  f.undo.createdGroupIds.push(101);f.tabs[0].groupId=101;
  const result=await undoGroups(f.api,f.undo);assert.equal(result.tabs,1);assert.equal(f.tabs[0].groupId,101);
});
test('target changes during Chrome grouping produce a recoverable incomplete result',async()=>{
  const f=fixture();const group=f.api.tabs.group;
  f.api.tabs.group=async options=>{const id=await group(options);f.groups[0].title='Concurrent rename';return id;};
  await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,f.save),/撤销/);assert.equal(f.undo.phase,'applying');
  await undoGroups(f.api,f.undo);assert.equal(f.groups[0].title,'Concurrent rename');assert.equal(f.tabs[2].groupId,90);
});
test('legacy pending-array recovery remains supported after upgrade',async()=>{
  const f=fixture();f.tabs[0].groupId=100;f.tabs[1].groupId=100;
  const undo={windowId:1,affected:[1,2],originalGroupIds:[90,91],createdGroupIds:[],pending:[1,2],order:[]};
  assert.equal((await undoGroups(f.api,undo)).tabs,2);
});

test('failed preflight cannot later undo a concurrent manual assignment',async()=>{
  for (const target of [90,100]) {
    const f=fixture();let count=0;
    if(target===100)f.preview.groups=[{title:'New',color:'blue',tabIds:[1,2]}];
    await assert.rejects(applyGroups(f.api,f.preview,DEFAULTS,async undo=>{
      await f.save(undo);
      if(++count===2){f.tabs[0].groupId=target;if(target===100)f.tabs[1].groupId=target;}
    }),/撤销/);
    assert.equal(f.calls.filter(call=>call[0]==='group').length,0);assert.equal(f.undo.pending,null);
    assert.equal((await undoGroups(f.api,f.undo)).tabs,0);assert.equal(f.tabs[0].groupId,target);
  }
});
