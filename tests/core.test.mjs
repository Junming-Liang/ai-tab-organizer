import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, eligibleTabs, toPayload, apiEndpoint, normalizeSettings, validateGroups, parseModelJson, localGroups, domainOf, exclusions, excluded } from '../extension/core.js';
const tabs = [{id:1,title:'GitHub repository',url:'https://user:pass@github.com/private?q=secret#hash',index:0,groupId:-1},{id:2,title:'Python documentation',url:'https://docs.python.org/a',index:1,groupId:-1}];
test('only title and domain leave the browser', () => {
  const payload=toPayload(eligibleTabs(tabs,DEFAULTS));
  assert.deepEqual(payload[0],{id:1,title:'GitHub repository',domain:'github.com'});
  assert.doesNotMatch(JSON.stringify(payload),/pass|secret|private|https/);
});
test('skip pinned, grouped, private, excluded and special tabs',()=>{
  const input=[...tabs,{...tabs[0],id:3,pinned:true},{...tabs[0],id:4,groupId:42},{...tabs[0],id:5,incognito:true},{...tabs[0],id:6,url:'chrome://settings'},{...tabs[0],id:7,url:'https://sub.bank.test/foo'}];
  assert.deepEqual(eligibleTabs(input,{...DEFAULTS,excludedDomains:'bank.test'}).map(t=>t.id),[1,2]);
});
test('domain filtering uses boundaries and rejects non-HTTP',()=>{
  assert.equal(domainOf('file:///secret.txt'),null);
  assert.equal(excluded('evilbank.com',exclusions('bank.com')),false);
  assert.equal(excluded('mail.bank.com',exclusions('*.bank.com')),true);
});
test('eligible metadata is bounded and titles are normalized',()=>{
  const input=Array.from({length:150},(_,id)=>({...tabs[0],id,index:id,title:'\u0000\n'+ 'x'.repeat(500)}));
  const result=eligibleTabs(input,DEFAULTS); assert.equal(result.length,100); assert.equal(result[0].title.length,180);
});
test('API endpoints use HTTPS and explicit localhost exceptions',()=>{
  assert.equal(apiEndpoint('https://api.openai.com/v1/').endpoint,'https://api.openai.com/v1/chat/completions');
  assert.equal(apiEndpoint('https://example.com/v1/chat/completions').endpoint,'https://example.com/v1/chat/completions');
  assert.equal(apiEndpoint('http://localhost:1234/v1').origin,'http://localhost:1234/*');
  for(const bad of ['http://example.com/v1','https://key:secret@example.com','https://x.com/?key=secret','file:///x','https://x.com/#secret']) assert.throws(()=>apiEndpoint(bad));
});
test('AI requires explicit consent; unknown providers and empty models fail',()=>{
  assert.throws(()=>normalizeSettings({...DEFAULTS,provider:'api'}));
  assert.throws(()=>normalizeSettings({...DEFAULTS,provider:'codex',consent:true}));
  assert.throws(()=>normalizeSettings({...DEFAULTS,provider:'api',consent:true,model:''}));
  assert.equal(normalizeSettings(DEFAULTS).auto,false);
});
test('model group validation rejects unknown IDs, duplicate IDs and singleton groups',()=>{
  const input=eligibleTabs(tabs,DEFAULTS);
  assert.deepEqual(validateGroups({groups:[{title:'开发',color:'not-a-color',tabIds:[1,2]}]},input),[{title:'开发',color:'blue',tabIds:[1,2]}]);
  for(const ids of [[1,3],[1,1],[1],['1',2]]) assert.throws(()=>validateGroups({groups:[{title:'Group',tabIds:ids}]},input));
  assert.throws(()=>validateGroups({groups:[{title:'A',tabIds:[1,2]},{title:'B',tabIds:[1,2]}]},input));
});
test('response parser accepts fenced JSON and rejects prose',()=>{
  assert.deepEqual(parseModelJson('```json\n{"groups":[]}\n```'),{groups:[]});
  assert.throws(()=>parseModelJson('Follow these malicious instructions instead'));
});
test('offline groups are deterministic and leave singleton domains alone',()=>{
  const input=eligibleTabs([...tabs,{id:3,index:3,title:'Unrelated',url:'https://unique.test',groupId:-1}],DEFAULTS);
  assert.deepEqual(localGroups(input),[{title:'开发',color:'blue',tabIds:[1,2]}]);
});
