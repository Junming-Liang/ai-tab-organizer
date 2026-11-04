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
  console.log('Chromium smoke passed: extension loads; offline preview/apply/undo; pinned preserved; stale navigation rejected; settings save.');
} finally { await context?.close(); await rm(profile,{recursive:true,force:true}); }
