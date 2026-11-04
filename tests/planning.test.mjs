import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,localGroups,localBuckets} from '../extension/core.js';
import {snapshotGroups,matchExisting,makePlan,validatePlan,groupFingerprint} from '../extension/planning.js';
const dev={id:1,index:0,title:'GitHub',domain:'github.com'};
const group=(id,title,domains=[]) => ({id,windowId:1,title,color:'orange',collapsed:true,tabIds:[id+100],domains});
test('one new tab matches an existing category without invoking any provider',async()=>{
  assert.deepEqual(await makePlan([dev],[group(9,'开发')],()=>assert.fail('no provider needed')),[{title:'开发',color:'orange',targetGroupId:9,tabIds:[1]}]);
});
test('existing domain match works with custom and unnamed native groups',()=>{
  assert.equal(matchExisting(dev,[group(8,'Project Banana',['github.com'])]).id,8);
  assert.equal(matchExisting(dev,[group(8,'',['github.com'])]).id,8);
});
test('ambiguous domains and duplicate names are not assigned arbitrarily',()=>{
  assert.equal(matchExisting(dev,[group(8,'A',['github.com']),group(9,'B',['github.com'])]),null);
  assert.equal(matchExisting(dev,[group(8,'开发'),group(9,'开发')]),null);
  assert.equal(matchExisting(dev,[group(8,'开发',['github.com']),group(9,'B',['github.com'])]).id,8);
});
test('exact normalized English category aliases match but partial names do not',()=>{
  assert.equal(matchExisting(dev,[group(8,' Development ')]).id,8);
  assert.equal(matchExisting(dev,[group(8,'Not Development')]),null);
});
test('only unmatched ungrouped metadata goes to the original classifier',async()=>{
  const tabs=[dev,{id:2,title:'A',domain:'a.test'},{id:3,title:'B',domain:'b.test'}]; let received;
  const result=await makePlan(tabs,[group(8,'Secret project',['github.com'])],async remaining=>{received=remaining;return [{title:'Other',color:'blue',tabIds:[2,3]}];});
  assert.deepEqual(received.map(tab=>tab.id),[2,3]);assert.doesNotMatch(JSON.stringify(received),/Secret project/);assert.equal(result.length,2);
});
test('one unmatched tab is left untouched without a useless AI request',async()=>{
  assert.deepEqual(await makePlan([dev],[],()=>assert.fail('no provider needed')),[]);
});
test('model proposal matching an existing title is converted to addition locally',async()=>{
  const tabs=[{id:1,title:'A',domain:'a.test'},{id:2,title:'B',domain:'b.test'}];
  assert.equal((await makePlan(tabs,[group(8,'Project Banana')],async()=>[{title:'project banana',color:'blue',tabIds:[1,2]}]))[0].targetGroupId,8);
});
test('same-target matches merge without renaming or recoloring old groups',async()=>{
  const result=await makePlan([dev,{...dev,id:2}],[group(8,'开发')],()=>assert.fail('no provider'));
  assert.equal(result.length,1);assert.deepEqual(result[0].tabIds,[1,2]);assert.equal(result[0].color,'orange');
});
test('snapshot excludes cross-window/shared groups and excluded member hints',()=>{
  const tabs=[{id:1,index:0,windowId:1,groupId:8,url:'https://bank.test/private',title:'Secret'}, {id:2,index:1,windowId:1,groupId:8,url:'https://github.com/project',title:'Project'}, {id:3,index:2,windowId:2,groupId:9,url:'https://other.test'}];
  const groups=snapshotGroups([group(8,'Work'),{...group(9,'Other'),windowId:2},{...group(10,'Shared'),shared:true}],tabs,{...DEFAULTS,excludedDomains:'bank.test'},1);
  assert.equal(groups.length,1);assert.deepEqual(groups[0].tabIds,[1,2]);assert.deepEqual(groups[0].domains,['github.com']);assert.doesNotMatch(JSON.stringify(groups),/private|Secret/);
});
test('plan rejects unknown targets/IDs, duplicate tabs, empty groups and new singletons',()=>{
  const targets=[group(8,'开发')];
  for (const plan of [[{targetGroupId:99,tabIds:[1]}],[{targetGroupId:8,tabIds:[99]}],[{targetGroupId:8,tabIds:[1,1]}],[{targetGroupId:8,tabIds:[]}],[{title:'New',tabIds:[1]}]]) assert.throws(()=>validatePlan(plan,[dev],targets));
  assert.deepEqual(validatePlan([{targetGroupId:8,title:'Overwrite',color:'red',tabIds:[1]}],[dev],targets),[{targetGroupId:8,title:'开发',color:'orange',tabIds:[1]}]);
});
test('group fingerprint changes on membership, rename, collapse or domain change',()=>{
  const base=group(8,'开发');const fp=groupFingerprint([base]);
  for (const change of [{title:'Other'},{collapsed:false},{tabIds:[999]},{domains:['other.test']}]) assert.notEqual(groupFingerprint([{...base,...change}]),fp);
});
test('local topics do not classify Capital or newspaper fragments as API or paper',()=>{
  const tabs=[{id:1,title:'Capital plan',domain:'finance.example'},{id:2,title:'Capital investing',domain:'finance.example'}];
  assert.equal(localGroups(tabs)[0].title,'finance.example');assert.equal(localBuckets([{id:3,title:'My newspaper',domain:'unique.test'}])[0].title,'unique.test');
});
