import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DEFAULTS, normalizeSettings} from '../extension/core.js';
import {classify} from '../extension/providers.js';
import {nativeRequest, siwcStatus, siwcModels, SIWC_HOST, SIWC_TIMEOUT_MS} from '../extension/siwc.js';

const tabs = [{id:1,title:'GitHub',domain:'github.com',url:'https://github.com/private?token=never-send',index:0}, {id:2,title:'Python',domain:'python.org',url:'https://python.org/private',index:1}];
const ACCOUNT_ID = '0123456789abcdef';
const OTHER_ACCOUNT_ID = 'fedcba9876543210';
const account = {accountId:ACCOUNT_ID,account:'test@example.test'};
const siwcConfig = {...DEFAULTS,provider:'siwc',siwcConsent:true,siwcModel:'gpt-test',siwcAccount:ACCOUNT_ID};
const grouped = {groups:[{title:'开发',color:'blue',tabIds:[1,2]}]};
function event() { const listeners=new Set(); return {listeners,addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),fire(...args){for(const fn of [...listeners])fn(...args);}}; }
function nativeFixture(reply, {permission = true} = {}) {
  const calls=[]; const permissions=[]; const ports=[];
  const chromeApi = {permissions:{contains:async request=>{permissions.push(request);return permission;}},runtime:{
    connectNative(host) {
      assert.equal(host,SIWC_HOST);
      const port={onMessage:event(),onDisconnect:event(),disconnects:0,disconnect(){this.disconnects++;},postMessage(message){calls.push(message);reply?.(message,port);}};
      ports.push(port);return port;
    },
  }};
  return {chromeApi,calls,permissions,ports};
}
const ok = result => (message,port) => queueMicrotask(()=>port.onMessage.fire({id:message.id,ok:true,result}));

test('SIWC remains opt-in with independent consent and no API model fallback',async()=>{
  assert.equal(DEFAULTS.provider,'local'); assert.equal(DEFAULTS.siwcConsent,false); assert.equal(DEFAULTS.siwcModel,'');
  assert.throws(()=>normalizeSettings({...DEFAULTS,provider:'siwc',consent:true,siwcModel:'gpt-test'}),/单独确认/);
  assert.throws(()=>normalizeSettings({...siwcConfig,siwcModel:''}),/选择有效/);
  assert.throws(()=>normalizeSettings({...siwcConfig,siwcModel:'https://untrusted.example/model'}),/选择有效/);
  assert.throws(()=>normalizeSettings({...siwcConfig,provider:'api',consent:false}),/确认/);
  assert.equal(normalizeSettings(siwcConfig).siwcModel,'gpt-test');
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url)));
  assert.deepEqual(manifest.optional_permissions,['nativeMessaging']);
  assert.equal(manifest.permissions.includes('nativeMessaging'),false);
  assert.equal(manifest.host_permissions,undefined);
});
test('native classification sends only allowed metadata and releases the port',async()=>{
  const f=nativeFixture(ok(grouped));
  const result=await nativeRequest('classify',{accountId:ACCOUNT_ID,model:'gpt-test',categories:'开发',tabs,apiKey:'must-not-send',token:'never-send',url:'https://private.example'},{chromeApi:f.chromeApi});
  assert.deepEqual(result,grouped);
  assert.deepEqual(f.permissions,[{permissions:['nativeMessaging']}]);
  assert.equal(f.calls.length,1); assert.equal(typeof f.calls[0].id,'string');
  const {id,...sent}=f.calls[0];
  assert.deepEqual(sent,{type:'classify',accountId:ACCOUNT_ID,model:'gpt-test',categories:'开发',tabs:[{id:1,title:'GitHub',domain:'github.com'},{id:2,title:'Python',domain:'python.org'}]});
  assert.doesNotMatch(JSON.stringify(sent),/never-send|must-not-send|private|https|token|apiKey/);
  assert.equal(f.ports[0].disconnects,1); assert.equal(f.ports[0].onMessage.listeners.size,0); assert.equal(f.ports[0].onDisconnect.listeners.size,0);
});
test('permission denial fails before connecting and no native login operation exists',async()=>{
  const f=nativeFixture(null,{permission:false});
  await assert.rejects(nativeRequest('status',{}, {chromeApi:f.chromeApi}),/尚未授权/);
  await assert.rejects(nativeRequest('login',{}, {chromeApi:f.chromeApi}),/不支持/);
  assert.equal(f.ports.length,0);
});
test('status and models never forward accidental extra input or output fields',async()=>{
  const f=nativeFixture(ok({connected:true,...account,access_token:'never-expose'}));
  assert.deepEqual(await siwcStatus(type=>nativeRequest(type,{token:'never-send'},{chromeApi:f.chromeApi})),{connected:true,...account});
  assert.deepEqual(Object.keys(f.calls[0]).sort(),['id','type']);
  const g=nativeFixture(ok({...account,models:[{slug:'gpt-test',display_name:'Test Model',token:'never-expose'}],access_token:'never-expose'}));
  assert.deepEqual(await siwcModels(type=>nativeRequest(type,{}, {chromeApi:g.chromeApi})),{...account,models:[{slug:'gpt-test',display_name:'Test Model'}]});
});
test('native errors are safe and ports close on failures and timeouts',async()=>{
  const f=nativeFixture((message,port)=>queueMicrotask(()=>port.onMessage.fire({id:message.id,ok:false,error:'共享计划额度不足，请稍后重试。'})));
  await assert.rejects(nativeRequest('status',{}, {chromeApi:f.chromeApi}),/额度不足/);
  assert.equal(f.ports[0].disconnects,1);
  const g=nativeFixture((message,port)=>queueMicrotask(()=>port.onMessage.fire({id:message.id,ok:false,error:'请求失败 Bearer secret-token'})));
  await assert.rejects(nativeRequest('status',{}, {chromeApi:g.chromeApi}),error=>!error.message.includes('secret-token')&&error.message.includes('请求失败'));
  const h=nativeFixture((_message,port)=>queueMicrotask(()=>{h.chromeApi.runtime.lastError={message:'/private/token-file'};port.onDisconnect.fire();}));
  await assert.rejects(nativeRequest('status',{}, {chromeApi:h.chromeApi}),error=>error.message.includes('安装')&&!error.message.includes('token-file'));
  assert.equal(h.ports[0].disconnects,1);
  assert.equal(SIWC_TIMEOUT_MS,90_000);
  const slow=nativeFixture();
  await assert.rejects(nativeRequest('status',{}, {chromeApi:slow.chromeApi,timeoutMs:5}),/90 秒/);
  assert.equal(slow.ports[0].disconnects,1);
});
test('unexpected response IDs are ignored and malformed matching responses fail',async()=>{
  const f=nativeFixture((message,port)=>queueMicrotask(()=>{port.onMessage.fire({id:'wrong-id',ok:true,result:{connected:false}});port.onMessage.fire({id:message.id,ok:true,result:{connected:true}});}));
  assert.deepEqual(await nativeRequest('status',{}, {chromeApi:f.chromeApi}),{connected:true});
  const g=nativeFixture((message,port)=>queueMicrotask(()=>port.onMessage.fire({id:message.id,ok:'true',result:{}})));
  await assert.rejects(nativeRequest('status',{}, {chromeApi:g.chromeApi}),/无效响应/);
  const h=nativeFixture(()=>{throw Error('raw credential error');});
  await assert.rejects(nativeRequest('status',{}, {chromeApi:h.chromeApi}),error=>!error.message.includes('credential'));
  assert.equal(h.ports[0].disconnects,1);
});
test('model lists and connection status are strictly validated',async()=>{
  for(const result of [{},{connected:'yes'}])await assert.rejects(siwcStatus(async()=>result),/无效/);
  for(const result of [{},{models:[{slug:'gpt-test'},{slug:'gpt-test'}]},{models:[{slug:'https://evil.example'}]},{models:Array(201).fill({slug:'gpt-test'})}])await assert.rejects(siwcModels(async()=>({...account,...result})),/无效/);
  await assert.rejects(siwcModels(async()=>({...account,models:[]})),/没有可用模型/);
});
test('SIWC provider never uses API keys or fetch and validates groups again',async()=>{
  let calls=0;
  const dependencies={apiKey:'unused-api-key',fetcher:()=>assert.fail('SIWC must not use API fetch'),nativeRequester:async(type,payload)=>{calls++;assert.equal(type,'classify');assert.deepEqual(Object.keys(payload).sort(),['accountId','categories','model','tabs']);assert.equal(payload.model,'gpt-test');assert.equal(payload.accountId,ACCOUNT_ID);assert.equal(payload.tabs[0].url,undefined);return grouped;}};
  assert.deepEqual(await classify(tabs,siwcConfig,dependencies),grouped.groups);
  await assert.rejects(classify(tabs,{...siwcConfig,siwcConsent:false,consent:true},dependencies),/单独确认/);
  assert.equal(calls,1);
  await assert.rejects(classify(tabs,siwcConfig,{nativeRequester:async()=>({groups:[{title:'Bad',tabIds:[1,999]}]})}),/未知或重复/);
  await assert.rejects(classify(tabs,siwcConfig,{nativeRequester:async()=>({groups:[{title:'Bad',tabIds:[1,1]}]})}),/未知或重复/);
});
function store(initial={}) {
  const values=structuredClone(initial);
  return {values,setAccessLevel:async()=>{},get:async keys=>keys==null?structuredClone(values):Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in values).map(k=>[k,structuredClone(values[k])])),set:async data=>{Object.assign(values,structuredClone(data));},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete values[key];}};
}
async function backgroundFixture({permission=true,connected=true,models=[{slug:'gpt-test',display_name:'Test'}],accountId=ACCOUNT_ID,modelsAccountId=accountId,classification=grouped}={}) {
  const native=nativeFixture((message,port)=>ok(message.type==='status'?{connected,...account,accountId}:message.type==='models'?{...account,models,accountId:modelsAccountId}:(typeof classification==='function'?classification(message):classification))(message,port),{permission});
  const chrome={...native.chromeApi,storage:{session:store(),local:store({settings:{...DEFAULTS}})},runtime:{...native.chromeApi.runtime,id:'test',getURL:()=> 'chrome-extension://test/',onMessage:event(),onStartup:event(),onInstalled:event()},alarms:{get:async()=>null,create:async()=>{},clear:async()=>{},onAlarm:event()},tabs:{query:async()=>tabs.map((t,index)=>({...t,url:`https://${t.domain}/`,groupId:-1,index})),onCreated:event(),onUpdated:event()},tabGroups:{query:async()=>[]},windows:{onRemoved:event()}};
  globalThis.chrome=chrome;
  await import(`../extension/background.js?siwc-test=${Math.random()}`);
  const listener=[...chrome.runtime.onMessage.listeners][0];
  const message=data=>new Promise(resolve=>listener(data,{id:'test',url:'chrome-extension://test/options.html'},resolve));
  return {...native,chrome,message,listener};
}
test('saving SIWC validates native permission, connection and model before persisting',async()=>{
  for(const [options,pattern] of [[{permission:false},/尚未授权/],[{connected:false},/尚未登录/],[{models:[{slug:'other',display_name:'Other'}]},/当前不可用/],[{accountId:OTHER_ACCOUNT_ID},/账户发生变化/],[{modelsAccountId:OTHER_ACCOUNT_ID},/账户发生变化/]]) {
    const f=await backgroundFixture(options);
    const result=await f.message({type:'saveSettings',settings:siwcConfig});
    assert.equal(result.ok,false); assert.match(result.error,pattern);assert.equal(f.chrome.storage.local.values.settings.provider,'local');
  }
  const f=await backgroundFixture();
  const result=await f.message({type:'saveSettings',settings:siwcConfig});
  assert.equal(result.ok,true);assert.equal(result.result.hasKey,false);assert.equal(f.chrome.storage.local.values.settings.provider,'siwc');
  assert.deepEqual(f.calls.map(call=>call.type),['status','models']);
  assert.equal((await f.message({type:'preview',windowId:1})).ok,true);
  assert.deepEqual(f.calls.map(call=>call.type),['status','models','classify']);
});
test('only extension pages can check the companion; arbitrary native methods are not exposed',async()=>{
  const f=await backgroundFixture();
  assert.equal(f.listener({type:'siwcStatus'},{id:'other',url:'https://evil.example'},()=>assert.fail('must not respond')),false);
  assert.equal(f.listener({type:'siwcModels'},{id:'test',url:'https://evil.example'},()=>assert.fail('must not respond')),false);
  assert.equal(f.calls.length,0);
  assert.equal((await f.message({type:'siwcLogin'})).ok,false);
  assert.deepEqual((await f.message({type:'siwcStatus'})).result,{connected:true,...account});
});

async function optionsFixture({initial={...DEFAULTS},connected=true,permission=true}={}) {
  const html=await readFile(new URL('../extension/options.html',import.meta.url),'utf8');
  const elements=new Map();
  function element(id,type='') {
    const listeners=new Map(); const classes=new Set();
    return {id,type,value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],classList:{toggle(name,on){on?classes.add(name):classes.delete(name);},contains:name=>classes.has(name)},
      addEventListener(name,fn){listeners.set(name,fn);},fire(name,event={preventDefault(){}}){return listeners.get(name)?.(event);},
      replaceChildren(...children){this.children=[...children];this.value=children[0]?.value||'';},append(child){this.children.push(child);},
    };
  }
  for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g))elements.set(match[3],element(match[3],match[2].match(/\btype="([^"]+)"/)?.[1]||match[1]));
  const document={getElementById:id=>elements.get(id),querySelectorAll:()=>[...elements.values()].filter(item=>['input','select','textarea','button','checkbox','password','url','submit'].includes(item.type)),createElement:tag=>element('',tag)};
  const calls=[]; const state={connected,permission,permissionGate:null,accountId:ACCOUNT_ID,modelsAccountId:null,saveError:null};
  const chrome={permissions:{request(input){calls.push({type:'permission',input});return state.permissionGate||Promise.resolve(state.permission);}},runtime:{async sendMessage(message){
    calls.push(message);
    if(message.type==='settings')return {ok:true,result:{settings:initial,hasKey:false}};
    if(message.type==='siwcStatus')return {ok:true,result:{connected:state.connected,...account,accountId:state.accountId}};
    if(message.type==='siwcModels')return {ok:true,result:{...account,accountId:state.modelsAccountId||state.accountId,models:[{slug:'gpt-test',display_name:'Test'}]}};
    if(message.type==='saveSettings')return state.saveError ? {ok:false,error:state.saveError} : {ok:true,result:{saved:true,hasKey:false}};
    throw Error(`Unexpected UI message ${message.type}`);
  }}};
  const original={chrome:globalThis.chrome,document:globalThis.document};
  globalThis.chrome=chrome;globalThis.document=document;
  await import(`../extension/options.js?siwc-test=${Math.random()}`);
  return {elements,calls,state,restore(){globalThis.chrome=original.chrome;globalThis.document=original.document;}};
}
test('options only connect on a gesture and deny or retry safely without auto-login',async()=>{
  const f=await optionsFixture();const $=id=>f.elements.get(id);
  try {
    assert.deepEqual(f.calls.map(c=>c.type),['settings']);
    $('provider').value='siwc';$('provider').fire('change');
    assert.equal($('siwc-fields').hidden,false);assert.equal($('api-fields').hidden,true);assert.equal($('local-note').hidden,true);
    f.state.permission=false;
    const denied=$('siwc-connect').fire('click');
    assert.deepEqual(f.calls.at(-1),{type:'permission',input:{permissions:['nativeMessaging']}});
    await denied;
    assert.match($('siwc-status').textContent,/未授权/);assert.equal($('siwc-connect').disabled,false);
    assert.equal(f.calls.some(c=>c.type==='siwcStatus'),false);
    f.state.permission=true;f.state.connected=false;
    await $('siwc-connect').fire('click');
    assert.match($('siwc-status').textContent,/ai-tab-companion login/);
    assert.equal(f.calls.some(c=>c.type==='siwcModels'),false);
    f.state.connected=true;
    await $('siwc-refresh').fire('click');
    assert.match($('siwc-status').textContent,/当前账户：test@example.test/);
    assert.equal($('siwcModel').value,'');assert.equal($('siwcModel').children.length,2);
    assert.equal(f.calls.some(c=>/login/i.test(c.type)),false);
  } finally {f.restore();}
});
test('options prevent repeated connection requests, require explicit model and reset cross-provider consent',async()=>{
  const f=await optionsFixture({initial:{...DEFAULTS,consent:true}});const $=id=>f.elements.get(id);
  try {
    $('provider').value='siwc';$('provider').fire('change');
    assert.equal($('consent').checked,false);assert.equal($('siwcConsent').checked,false);
    let release; f.state.permissionGate=new Promise(resolve=>{release=resolve;});
    const first=$('siwc-connect').fire('click');
    await $('siwc-connect').fire('click');
    assert.equal(f.calls.filter(c=>c.type==='permission').length,1);
    assert.equal($('provider').disabled,true);assert.equal($('save').disabled,true);
    release(true);await first;f.state.permissionGate=null;
    assert.equal($('provider').disabled,false);
    $('siwcConsent').checked=true;
    await $('form').fire('submit');
    assert.match($('status').textContent,/选择有效/);assert.equal(f.calls.some(c=>c.type==='saveSettings'),false);
    $('siwcModel').value='gpt-test';$('apiKey').value='must-not-forward';
    const save=$('form').fire('submit');
    assert.deepEqual(f.calls.at(-1),{type:'permission',input:{permissions:['nativeMessaging']}});
    await save;
    const saved=f.calls.find(c=>c.type==='saveSettings');assert.equal(saved.settings.siwcConsent,true);assert.equal(saved.settings.consent,false);assert.equal(saved.apiKey,undefined);
    assert.match($('status').textContent,/SIWC 设置已保存/);
    $('provider').value='api';$('provider').fire('change');
    assert.equal($('siwcConsent').checked,false);assert.equal($('consent').checked,false);
    assert.equal($('api-fields').hidden,false);assert.equal($('siwc-fields').hidden,true);
  } finally {f.restore();}
});
test('loading saved SIWC settings does not start the companion or a login',async()=>{
  const f=await optionsFixture({initial:siwcConfig});
  try {
    assert.deepEqual(f.calls.map(c=>c.type),['settings']);
    assert.equal(f.elements.get('siwcModel').value,'gpt-test');
    assert.equal(f.elements.get('siwc-fields').hidden,false);
  } finally {f.restore();}
});
test('SIWC requires a valid account binding and never forwards tokens as account IDs',async()=>{
  const f=nativeFixture(ok(grouped));
  for(const accountId of ['', 'not-a-binding', '0123456789abcdeF', 'access-token-value']) {
    assert.throws(()=>normalizeSettings({...siwcConfig,siwcAccount:accountId}),/账户/);
    await assert.rejects(nativeRequest('classify',{accountId,model:'gpt-test',categories:'开发',tabs},{chromeApi:f.chromeApi}),/账户/);
    await assert.rejects(siwcStatus(async()=>({connected:true,accountId})),/账户标识无效/);
    await assert.rejects(siwcModels(async()=>({accountId,models:[{slug:'gpt-test'}]})),/账户标识无效/);
  }
  assert.equal(f.calls.length,0);
  assert.deepEqual(await siwcStatus(async()=>({connected:false,accountId:'ignored',access_token:'never-expose'})),{connected:false});
  await assert.rejects(classify(tabs,{...siwcConfig,siwcAccount:''},{nativeRequester:()=>assert.fail('unbound account must not send')}),/账户/);
});
test('refreshing after an account switch clears the model and consent and shows the active account',async()=>{
  const f=await optionsFixture({initial:siwcConfig});const $=id=>f.elements.get(id);
  try {
    f.state.accountId=OTHER_ACCOUNT_ID;
    await $('siwc-refresh').fire('click');
    assert.equal($('siwcAccount').value,OTHER_ACCOUNT_ID);assert.equal($('siwcModel').value,'');assert.equal($('siwcConsent').checked,false);
    assert.match($('siwc-status').textContent,/当前账户：test@example.test/);assert.match($('siwc-status').textContent,/账户已切换/);
    assert.equal(f.calls.some(c=>c.type==='saveSettings'),false);
    $('siwcConsent').checked=true;$('siwcModel').value='gpt-test';
    f.state.modelsAccountId=ACCOUNT_ID;
    await $('siwc-refresh').fire('click');
    assert.match($('siwc-status').textContent,/账户发生变化/);
    assert.equal($('siwcAccount').value,'');assert.equal($('siwcModel').value,'');assert.equal($('siwcConsent').checked,false);
  } finally {f.restore();}
});
test('account changes detected during save clear the stale UI binding and require fresh confirmation',async()=>{
  const f=await optionsFixture({initial:siwcConfig});const $=id=>f.elements.get(id);
  try {
    f.state.saveError='ChatGPT 账户发生变化，请刷新连接、重新选择模型并确认数据发送同意。';
    await $('form').fire('submit');
    assert.match($('status').textContent,/账户发生变化/);
    assert.equal($('siwcAccount').value,'');assert.equal($('siwcModel').value,'');assert.equal($('siwcConsent').checked,false);
    assert.equal($('save').disabled,false);
  } finally {f.restore();}
});

test('integrated SIWC planning keeps old group context local and sends only unmatched tabs',async()=>{
  const f=await backgroundFixture({classification:message=>({groups:[{title:'研究',color:'purple',tabIds:message.tabs.map(tab=>tab.id)}]})});
  assert.equal((await f.message({type:'saveSettings',settings:siwcConfig})).ok,true);
  f.chrome.tabs.query=async()=>[
    {id:10,windowId:1,title:'Private old member title',url:'https://github.com/private-old',groupId:88,index:0},
    {id:1,windowId:1,title:'GitHub new',url:'https://github.com/new',groupId:-1,index:1},
    {id:2,windowId:1,title:'Research A',url:'https://arxiv.org/new',groupId:-1,index:2},
    {id:3,windowId:1,title:'Research B',url:'https://research.example/new',groupId:-1,index:3},
  ];
  f.chrome.tabGroups.query=async()=>[{id:88,windowId:1,title:'Private customer group',color:'orange',collapsed:true}];
  const response=await f.message({type:'preview',windowId:1});
  assert.equal(response.ok,true,response.error);
  const classification=f.calls.find(call=>call.type==='classify');
  assert.deepEqual(classification.tabs.map(tab=>tab.id),[2,3]);
  assert.doesNotMatch(JSON.stringify(classification),/Private|private-old|customer|github|targetGroupId|existingGroups/);
  assert.deepEqual(response.result.groups.find(group=>group.targetGroupId===88).tabIds,[1]);
  assert.deepEqual(response.result.groups.find(group=>group.targetGroupId==null).tabIds,[2,3]);
});
