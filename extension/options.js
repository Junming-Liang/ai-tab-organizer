import { DEFAULTS, normalizeSettings, apiEndpoint } from './core.js';
const $ = id => document.getElementById(id);
const fields = Object.keys(DEFAULTS);
async function request(message) { const r = await chrome.runtime.sendMessage(message); if (!r?.ok) throw new Error(r?.error || '后台未响应。'); return r.result; }
function show(message,error=false) { $('status').textContent = message; $('status').classList.toggle('error',error); }
function showProvider() { const api = $('provider').value === 'api'; $('api-fields').hidden = !api; $('local-note').hidden = api; }
function setFields(settings) { for (const field of fields) { const input = $(field); if (input.type === 'checkbox') input.checked = settings[field]; else input.value = settings[field]; } showProvider(); }
function getFields() { return Object.fromEntries(fields.map(field => [field,$(field).type === 'checkbox' ? $(field).checked : $(field).value])); }
$('provider').addEventListener('change',showProvider);
$('baseUrl').addEventListener('input',() => { $('consent').checked = false; });
for (const [name,url,model] of [['openai','https://api.openai.com/v1','gpt-4.1-mini'],['deepseek','https://api.deepseek.com/v1','deepseek-chat']]) {
  $(`preset-${name}`).addEventListener('click',() => { $('baseUrl').value=url; $('model').value=model; $('consent').checked=false; $('apiKey').value=''; });
}
$('form').addEventListener('submit',async event => {
  event.preventDefault(); $('save').disabled=true;
  try {
    const config = normalizeSettings(getFields());
    // Called directly in the user's click/submit gesture before any async work.
    if (config.provider === 'api') {
      const granted = await chrome.permissions.request({origins:[apiEndpoint(config.baseUrl).origin]});
      if (!granted) throw new Error('未授权 API 站点，设置未保存。');
    }
    const apiKey = $('apiKey').value.trim() || undefined;
    const result = await request({type:'saveSettings',settings:config,apiKey});
    $('apiKey').value=''; $('key-status').textContent = result.hasKey ? `已保存 Key（${config.rememberKey ? '本机持久存储' : '仅当前浏览器会话'}），不会显示完整内容。` : '尚未配置 Key。';
    show('设置已保存。回到扩展面板即可开始整理。');
  } catch(error) { show(error.message,true); } finally { $('save').disabled=false; }
});
$('clear-key').addEventListener('click',async () => {
  try { await request({type:'clearKey'}); $('apiKey').value=''; $('key-status').textContent='Key 已清除。'; show('已清除会话和本机保存的 Key。'); } catch(error){ show(error.message,true); }
});
try { const result = await request({type:'settings'}); setFields(result.settings); if(result.hasKey) $('key-status').textContent='已配置 Key。留空可保留当前 Key，改变 API 地址需要重新填写。'; }
catch(error){ show(error.message,true); }
