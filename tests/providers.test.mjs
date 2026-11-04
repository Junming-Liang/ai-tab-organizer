import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../extension/providers.js';
import { DEFAULTS } from '../extension/core.js';
const tabs=[{id:1,title:'GitHub',domain:'github.com',url:'https://secret/path'},{id:2,title:'Python',domain:'python.org'}];
const settings={...DEFAULTS,provider:'api',consent:true};
test('API uses minimal payload, bounded response and no redirects/cookies',async()=>{
  let captured;
  const groups=await classify(tabs,settings,{apiKey:'fake-test-key',fetcher:async(url,init)=>{
    captured={url,init}; return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({groups:[{title:'Dev',color:'blue',tabIds:[1,2]}]})}}]}),{status:200});
  }});
  assert.equal(groups.length,1); assert.equal(captured.init.redirect,'error'); assert.equal(captured.init.credentials,'omit');
  assert.equal(captured.init.headers.Authorization,'Bearer fake-test-key');
  assert.doesNotMatch(captured.init.body,/secret\/path/);
  assert.equal(JSON.parse(captured.init.body).response_format.type,'json_object');
});
test('provider errors do not echo response body or key',async()=>{
  await assert.rejects(classify(tabs,settings,{apiKey:'fake-test-key',fetcher:async()=>new Response('secret account payload',{status:401})}),error=>/HTTP 401/.test(error.message)&&!error.message.includes('secret'));
});
test('missing key or consent fails before network request',async()=>{
  const fetcher=()=>assert.fail('network must not run');
  await assert.rejects(classify(tabs,settings,{fetcher}));
  await assert.rejects(classify(tabs,{...settings,consent:false},{apiKey:'fake',fetcher}));
});
test('overlarge response is rejected',async()=>{
  await assert.rejects(classify(tabs,settings,{apiKey:'fake',fetcher:async()=>new Response('x'.repeat(300_000))}),/过大/);
});
test('offline mode never calls fetch',async()=>{
  const result=await classify(tabs,DEFAULTS,{fetcher:()=>assert.fail('no network')}); assert.equal(result.length,1);
});
