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
  // Serve synthetic pages without touching external websites.
  await context.route('https://**/*',route=>route.fulfill({contentType:'text/html',body:`<title>${route.request().url().includes('github')?'GitHub project':'Python docs'}</title><h1>Synthetic fixture</h1>`}));
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
  await mkdir('artifacts',{recursive:true});
  await popup.screenshot({path:'artifacts/popup.png',fullPage:true});
  await popup.locator('#apply').click();
  await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已整理'));
  let groups=await worker.evaluate(()=>chrome.tabGroups.query({}));assert.equal(groups.length,1);assert.equal(groups[0].title,'开发');
  assert.equal(await worker.evaluate(async id=>(await chrome.tabs.get(id)).groupId,pinnedId),-1);
  await popup.locator('#undo').click();await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('已撤销'));
  groups=await worker.evaluate(()=>chrome.tabGroups.query({}));assert.equal(groups.length,0);
  // Stale navigation rejects an old preview without mutating tabs.
  await popup.locator('#preview').click();await popup.locator('.group').waitFor();
  await a.goto('https://different.example/new');
  await popup.locator('#apply').click();await popup.waitForFunction(()=>document.querySelector('#status').classList.contains('error'));
  assert.equal((await worker.evaluate(()=>chrome.tabGroups.query({}))).length,0);
  const options=await context.newPage();await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#categories').fill('开发, 阅读');await options.locator('#save').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('设置已保存'));
  await options.screenshot({path:'artifacts/settings.png',fullPage:true});
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
  console.log('Chromium smoke passed: extension loads; offline preview/apply/undo; pinned preserved; stale navigation rejected; settings save; SIWC fixture permission denial, account/model selection, preview, changed-account rejection and consent reset. No live OAuth or native host used.');
} finally { await context?.close(); await rm(profile,{recursive:true,force:true}); }
