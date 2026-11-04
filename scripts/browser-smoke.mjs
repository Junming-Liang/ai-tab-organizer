// Optional local QA: npm install --no-save playwright, then npm run test:browser.
// Set CHROMIUM_PATH for an existing Chromium installation. No live AI API used.
import {createRequire} from 'node:module';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
let chromium;
try { ({chromium}=require('playwright')); } catch { throw new Error('Optional browser QA needs Playwright. Install locally with npm install --no-save playwright.'); }
const extension=path.resolve('extension');const profile=await mkdtemp(path.join(tmpdir(),'tab-organizer-qa-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{
    headless:true,channel:'chromium',...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-sandbox'],
  });
  context.setDefaultTimeout(15_000);
  // Intercept all page HTTP(S) traffic. No real websites or AI API are used.
  await context.route(/^https?:\/\//,route=>{
    const url=new URL(route.request().url());
    const title=url.hostname.includes('github')?'GitHub project':url.hostname.includes('python')?'Python docs':'Synthetic fixture';
    return route.fulfill({contentType:'text/html',body:`<title>${title}</title><h1>Synthetic fixture</h1>`});
  });
  let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  const a=await context.newPage();await a.goto('https://github.com/example/project');
  const b=await context.newPage();await b.goto('https://docs.python.org/3/');
  const c=await context.newPage();await c.goto('https://github.com/untouched/pinned');
  const pinnedId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.includes('/untouched/pinned'));await chrome.tabs.update(tab.id,{pinned:true});return tab.id;});
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#count').filter({hasText:'2'}).waitFor();
  await popup.locator('#preview').click();await popup.locator('.group').waitFor();
  assert.equal(await popup.locator('.group').count(),1);
  const readPreview=()=>popup.evaluate(async()=>{
    const windowId=(await chrome.windows.getCurrent()).id;
    return (await chrome.runtime.sendMessage({type:'state',windowId})).result.preview;
  });
  const initialPreview=await readPreview();
  await popup.locator('.group-name').fill('开发验收');
  await popup.locator('.group-name').dispatchEvent('change');
  await popup.waitForFunction(async revision=>{
    const windowId=(await chrome.windows.getCurrent()).id;
    return (await chrome.runtime.sendMessage({type:'state',windowId})).result.preview.revision>revision;
  },initialPreview.revision);
  await popup.waitForFunction(()=>document.querySelector('.group-name')?.value==='开发验收' && !document.querySelector('#apply').disabled);
  assert.equal((await readPreview()).groups[0].title,'开发验收');
  // A second panel holding the previous revision may not apply its stale copy.
  const stalePanel=await context.newPage(); await stalePanel.goto(`chrome-extension://${id}/popup.html`);
  const staleApply=await stalePanel.evaluate(async preview=>chrome.runtime.sendMessage({type:'apply',windowId:preview.windowId,previewId:preview.id,revision:preview.revision}),initialPreview);
  assert.equal(staleApply.ok,false); assert.match(staleApply.error,/预览已更新/);
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,0);
  await stalePanel.close();
  // Removing a member from a two-tab new group leaves both unassigned.
  await popup.locator('.tab-include').first().uncheck();
  await popup.waitForFunction(()=>document.querySelectorAll('.group').length===0 && document.querySelectorAll('.unassigned-tab').length===2);
  assert.equal(await popup.locator('#apply').isDisabled(),true);
  await popup.locator('#preview').click(); await popup.locator('.group').waitFor();
  await popup.locator('.group-name').fill('开发验收');
  await popup.locator('.group-name').dispatchEvent('change');
  await popup.waitForFunction(()=>document.querySelector('.group-name')?.value==='开发验收' && !document.querySelector('#apply').disabled);
  await mkdir('artifacts',{recursive:true});
  await popup.screenshot({path:'artifacts/popup.png',fullPage:true});
  await popup.locator('#apply').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已整理'));
  let groups=await worker.evaluate(()=>chrome.tabGroups.query({}));assert.equal(groups.length,1);assert.equal(groups[0].title,'开发验收');
  assert.equal(await worker.evaluate(async id=>(await chrome.tabs.get(id)).groupId,pinnedId),-1);
  await popup.locator('#undo').click();await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已撤销'));
  groups=await worker.evaluate(()=>chrome.tabGroups.query({}));assert.equal(groups.length,0);
  // Stale navigation rejects an old preview without mutating tabs.
  await popup.locator('#preview').click();await popup.locator('.group').waitFor();
  await a.goto('https://different.example/new');
  await popup.locator('#apply').click();await popup.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,0);
  // Native existing-group regression fixtures. These are real chrome.tabs and
  // chrome.tabGroups operations, not an in-memory browser API mock.
  await a.close(); await b.close();
  const member=await context.newPage(); await member.goto('https://github.com/existing/member');
  const oldGroup=await worker.evaluate(async()=>{
    const tab=(await chrome.tabs.query({})).find(t=>t.url?.includes('/existing/member'));
    const id=await chrome.tabs.group({tabIds:[tab.id]});
    await chrome.tabGroups.update(id,{title:'开发',color:'orange',collapsed:true});
    return {id,memberId:tab.id};
  });
  const incoming=await context.newPage(); await incoming.goto('https://github.com/new/singleton');
  const incomingId=await worker.evaluate(async()=>(await chrome.tabs.query({})).find(t=>t.url?.includes('/new/singleton')).id);
  async function reloadPopup() { await popup.reload(); await popup.locator('#count').filter({hasText:'1'}).waitFor(); }
  async function previewSingle() { await reloadPopup(); assert.equal(await popup.locator('#preview').isEnabled(),true); await popup.locator('#preview').click(); await popup.locator('.group').waitFor(); }
  async function groupSnapshot(groupId) {
    return worker.evaluate(async id=>{
      const group=await chrome.tabGroups.get(id);
      const members=(await chrome.tabs.query({groupId:id})).map(t=>t.id).sort((a,b)=>a-b);
      return {title:group.title,color:group.color,collapsed:group.collapsed,members};
    },groupId);
  }
  const oldSnapshot=await groupSnapshot(oldGroup.id);
  // Exercise reversible destination editing and unassigned singleton controls.
  await previewSingle();
  await popup.locator('.group .target-select').selectOption('skip');
  await popup.locator(`#unassigned .unassigned-tab[data-tab-id="${incomingId}"]`).waitFor();
  assert.equal(await popup.locator('#apply').isDisabled(),true);
  await popup.locator(`#unassigned .unassigned-tab[data-tab-id="${incomingId}"] .target-select`).selectOption(String(oldGroup.id));
  await popup.locator('.group').waitFor();
  assert.equal((await readPreview()).groups[0].targetGroupId,oldGroup.id);
  assert.deepEqual(await groupSnapshot(oldGroup.id),oldSnapshot,'Editing a preview must not mutate native groups');
  assert.equal(await popup.locator('.group').count(),1,'A single incoming tab can match a native group');
  assert.deepEqual(await groupSnapshot(oldGroup.id),oldSnapshot,'Preview must be read-only');
  await popup.screenshot({path:'artifacts/existing-group-preview.png',fullPage:true});
  await popup.locator('#apply').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已整理'));
  assert.equal(await worker.evaluate(async id=>(await chrome.tabs.get(id)).groupId,incomingId),oldGroup.id);
  assert.deepEqual(await groupSnapshot(oldGroup.id),{...oldSnapshot,members:[oldGroup.memberId,incomingId].sort((a,b)=>a-b)},'Existing group metadata and old members must survive apply');
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,1,'Do not create a duplicate same-topic group');
  await popup.locator('#undo').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已撤销'));
  assert.deepEqual(await groupSnapshot(oldGroup.id),oldSnapshot,'Undo removes only the inserted member');
  assert.equal(await worker.evaluate(async id=>(await chrome.tabs.get(id)).groupId,incomingId),-1);

  // A renamed destination invalidates a stale preview without changing tabs.
  await previewSingle();
  await worker.evaluate(id=>chrome.tabGroups.update(id,{title:'用户刚改名'}),oldGroup.id);
  const renamedSnapshot=await groupSnapshot(oldGroup.id);
  await popup.locator('#apply').click();
  await popup.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));
  assert.deepEqual(await groupSnapshot(oldGroup.id),renamedSnapshot);
  assert.equal(await worker.evaluate(async id=>(await chrome.tabs.get(id)).groupId,incomingId),-1);
  await worker.evaluate(id=>chrome.tabGroups.update(id,{title:'开发'}),oldGroup.id);

  // Undo must not take back a tab the user has since placed in another group.
  await previewSingle(); await popup.locator('#apply').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已整理'));
  const manualGroupId=await worker.evaluate(async tabId=>{
    const id=await chrome.tabs.group({tabIds:[tabId]});
    await chrome.tabGroups.update(id,{title:'手动保留',color:'purple'});return id;
  },incomingId);
  const manualSnapshot=await groupSnapshot(manualGroupId);
  await popup.locator('#undo').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已撤销'));
  assert.deepEqual(await groupSnapshot(manualGroupId),manualSnapshot);
  assert.deepEqual(await groupSnapshot(oldGroup.id),oldSnapshot);

  const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#categories').fill('开发, 阅读');await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('设置已保存'));
  await options.screenshot({path:'artifacts/settings.png',fullPage:true});
  // Isolate SIWC fixtures from the existing-group scenario above.
  await member.close(); await incoming.close();
  const siwcA=await context.newPage(); await siwcA.goto('https://siwc-one.example/fixture');
  const siwcB=await context.newPage(); await siwcB.goto('https://siwc-two.example/fixture');
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,0);
  // SIWC browser UI uses in-memory Chrome API fixtures only. No OS host,
  // credential store, OAuth endpoint, permission grant or inference is invoked.
  await options.selectOption('#provider','siwc');
  await options.evaluate(()=>{chrome.permissions.request=async()=>false;});
  await options.locator('#siwc-connect').click();
  await options.waitForFunction(()=>document.querySelector('#siwc-status').textContent.includes('未授权'));
  assert.equal(await options.locator('#siwcConsent').isChecked(),false);
  await options.evaluate(()=>{chrome.permissions.request=async()=>true;});
  await worker.evaluate(()=>{
    const originalContains=chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains=async query=>query.permissions?.includes('nativeMessaging')?true:originalContains(query);
    self.siwcFixture={accountId:'a'.repeat(16),requests:[]};
    chrome.runtime.connectNative=name=>{
      if(name!=='com.ai_tab_organizer.siwc')throw new Error('Unexpected native host');
      const listeners=new Set();const disconnectListeners=new Set();
      const port={onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},onDisconnect:{addListener:fn=>disconnectListeners.add(fn),removeListener:fn=>disconnectListeners.delete(fn)},disconnect(){},postMessage(message){
        self.siwcFixture.requests.push(message);
        const accountId=self.siwcFixture.accountId;const account='Synthetic test account';
        let result;
        if(message.type==='status')result={connected:true,accountId,account};
        else if(message.type==='models')result={accountId,account,models:[{slug:'fixture-model',display_name:'Synthetic model'}]};
        else if(message.type==='classify'&&message.accountId===accountId){
          if(message.tabs.some(tab=>Object.keys(tab).sort().join(',')!=='domain,id,title'))throw new Error('Unexpected metadata');
          result={groups:[{title:'Fixture group',color:'purple',tabIds:message.tabs.map(tab=>tab.id)}]};
        }
        const response=result?{id:message.id,ok:true,result}:{id:message.id,ok:false,error:'当前 ChatGPT 账户已变化，请刷新账户。'};
        queueMicrotask(()=>{for(const listener of listeners)listener(response);});
      }};
      return port;
    };
  });
  await options.locator('#siwc-connect').click();
  await options.waitForFunction(()=>document.querySelector('#siwc-status').textContent.includes('Synthetic test account'));
  await options.selectOption('#siwcModel','fixture-model');
  await options.locator('#siwcConsent').check();
  await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('SIWC 设置已保存'));
  await options.screenshot({path:'artifacts/settings-siwc.png',fullPage:true});
  await popup.reload();
  await popup.waitForFunction(()=>document.querySelector('#engine').textContent.includes('SIWC'));
  await popup.locator('#preview').click();
  await popup.waitForFunction(()=>document.querySelector('.group')?.textContent.includes('Fixture group'));
  await popup.screenshot({path:'artifacts/popup-siwc.png',fullPage:true});
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,0);
  await worker.evaluate(()=>{self.siwcFixture.accountId='b'.repeat(16);});
  await popup.locator('#preview').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('账户已变化'));
  await options.locator('#siwc-refresh').click();
  await options.waitForFunction(()=>document.querySelector('#siwc-status').textContent.includes('账户已切换'));
  assert.equal(await options.locator('#siwcModel').inputValue(),'');
  assert.equal(await options.locator('#siwcConsent').isChecked(),false);
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,0);
  console.log('Chromium smoke passed: extension loads; offline preview/apply/undo; pinned preserved; stale navigation rejected; settings save; native existing-group singleton match, metadata preservation, conservative undo, editable preview and stale revision rejection; SIWC fixture permission denial, account/model selection, preview, changed-account rejection and consent reset. No live OAuth or native host used.');
} finally { await context?.close(); await rm(profile,{recursive:true,force:true}); }
