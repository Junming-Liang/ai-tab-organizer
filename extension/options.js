import { DEFAULTS, normalizeSettings, apiEndpoint } from './core.js';
const $ = id => document.getElementById(id);
const fields = Object.keys(DEFAULTS);
let busy = false;
async function request(message) { const r = await chrome.runtime.sendMessage(message); if (!r?.ok) throw new Error(r?.error || '后台未响应。'); return r.result; }
function show(message,error=false) { $('status').textContent = message; $('status').classList.toggle('error',error); }
function showSiwc(message,error=false) { $('siwc-status').textContent = message; $('siwc-status').classList.toggle('error',error); }
function showProvider() {
  const provider = $('provider').value;
  $('api-fields').hidden = provider !== 'api';
  $('siwc-fields').hidden = provider !== 'siwc';
  $('local-note').hidden = provider !== 'local';
}
function setBusy(value) {
  busy = value;
  for (const input of document.querySelectorAll('#form input, #form select, #form textarea, #form button')) input.disabled = value;
}
function setModels(models, selected = '') {
  $('siwcModel').replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择 ChatGPT 模型';
  $('siwcModel').append(placeholder);
  for (const model of models) {
    const option = document.createElement('option'); option.value = model.slug; option.textContent = `${model.display_name} (${model.slug})`;
    $('siwcModel').append(option);
  }
  $('siwcModel').value = models.some(model => model.slug === selected) ? selected : '';
}
function setFields(settings) {
  if (settings.siwcModel) setModels([{slug:settings.siwcModel,display_name:'已保存；请检查可用状态'}],settings.siwcModel);
  for (const field of fields) { const input = $(field); if (input.type === 'checkbox') input.checked = settings[field]; else input.value = settings[field]; }
  showProvider();
}
function getFields() { return Object.fromEntries(fields.map(field => [field,$(field).type === 'checkbox' ? $(field).checked : $(field).value])); }
$('provider').addEventListener('change',() => {
  // Switching providers never carries a checked disclosure to the other mode.
  $('consent').checked = false; $('siwcConsent').checked = false; showProvider();
});
$('baseUrl').addEventListener('input',() => { $('consent').checked = false; });
for (const [name,url,model] of [['openai','https://api.openai.com/v1','gpt-4.1-mini'],['deepseek','https://api.deepseek.com/v1','deepseek-chat']]) {
  $(`preset-${name}`).addEventListener('click',() => { $('baseUrl').value=url; $('model').value=model; $('consent').checked=false; $('apiKey').value=''; });
}
async function checkSiwc() {
  if (busy) return;
  setBusy(true); showSiwc('正在检查本机 companion…');
  const selected = $('siwcModel').value;
  const previousAccount = $('siwcAccount').value;
  try {
    // Request directly in this click gesture, before any other async work.
    const granted = await chrome.permissions.request({permissions:['nativeMessaging']});
    if (!granted) throw new Error('未授权本机 companion 连接，未连接 ChatGPT。');
    const state = await request({type:'siwcStatus'});
    if (!state.connected) throw new Error('尚未登录 ChatGPT。请在本机终端运行 ai-tab-companion login，完成后再检查连接。');
    const {models,accountId} = await request({type:'siwcModels'});
    if (state.accountId !== accountId) throw new Error('ChatGPT 账户发生变化，请重新检查连接。');
    const changed = !!previousAccount && previousAccount !== accountId;
    if (changed) $('siwcConsent').checked = false;
    $('siwcAccount').value = accountId;
    setModels(models, changed ? '' : selected);
    showSiwc(`当前账户：${state.account || accountId}。可选择 ${models.length} 个模型，分类会消耗共享计划额度。${changed ? '账户已切换，请重新选择模型并确认同意。' : ''}`);
  } catch(error) {
    setModels([]); $('siwcAccount').value=''; $('siwcConsent').checked=false; showSiwc(error.message,true);
  } finally { setBusy(false); }
}
for (const id of ['siwc-connect','siwc-refresh']) $(id).addEventListener('click',checkSiwc);
$('form').addEventListener('submit',async event => {
  event.preventDefault(); if (busy) return;
  setBusy(true);
  try {
    const config = normalizeSettings(getFields());
    // Called directly in the user's click/submit gesture before any async work.
    if (config.provider === 'api') {
      const granted = await chrome.permissions.request({origins:[apiEndpoint(config.baseUrl).origin]});
      if (!granted) throw new Error('未授权 API 站点，设置未保存。');
    } else if (config.provider === 'siwc') {
      const granted = await chrome.permissions.request({permissions:['nativeMessaging']});
      if (!granted) throw new Error('未授权本机 companion 连接，设置未保存。');
    }
    const apiKey = config.provider === 'api' ? $('apiKey').value.trim() || undefined : undefined;
    const result = await request({type:'saveSettings',settings:config,apiKey});
    $('apiKey').value=''; $('key-status').textContent = result.hasKey ? '已保存 Key（仅当前浏览器会话），不会显示完整内容。' : '尚未配置 Key。';
    show(config.provider === 'siwc' ? 'ChatGPT / SIWC 设置已保存。分类会发送标题和域名并消耗共享计划额度。' : '设置已保存。回到扩展面板即可开始整理。');
  } catch(error) {
    if ($('provider').value === 'siwc' && /账户/.test(error.message)) {
      setModels([]); $('siwcAccount').value=''; $('siwcConsent').checked=false; showSiwc(error.message,true);
    }
    show(error.message,true);
  } finally { setBusy(false); }
});
$('clear-key').addEventListener('click',async () => {
  if (busy) return;
  setBusy(true);
  try { await request({type:'clearKey'}); $('apiKey').value=''; $('key-status').textContent='Key 已清除。'; show('已清除会话和本机保存的 Key。'); } catch(error){ show(error.message,true); }
  finally { setBusy(false); }
});
setBusy(true);
try { const result = await request({type:'settings'}); setFields(result.settings); if(result.hasKey) $('key-status').textContent='已配置 Key。留空可保留当前 Key，改变 API 地址需要重新填写。'; }
catch(error){ show(error.message,true); }
finally { setBusy(false); }
