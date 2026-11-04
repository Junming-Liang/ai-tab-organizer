import { DEFAULTS, normalizeSettings, eligibleTabs, fingerprint, apiEndpoint } from './core.js';
import { classify } from './providers.js';
import { siwcStatus, siwcModels } from './siwc.js';
import { applyGroups, undoGroups } from './organizer.js';
import {snapshotGroups, makePlan, validatePlan, mergeTargets} from './planning.js';

let queue = Promise.resolve();
const previewsInFlight = new Map();
function serial(operation) { const work = queue.then(operation, operation); queue = work.catch(() => {}); return work; }
const settingsReady = Promise.all([
  chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
  chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
 ]).then(() => chrome.storage.local.remove(['credentials','apiKey']));
async function settings() { await settingsReady; return {...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings, rememberKey:false}; }
async function getKey(config) {
  if (config.provider !== 'api') return '';
  const endpoint = apiEndpoint(config.baseUrl).endpoint;
  await settingsReady;
  const session = await chrome.storage.session.get('credentials');
  // Credential and destination are one record. A partial settings save can never
  // send a newly entered key to the previous endpoint.
  return session.credentials?.endpoint === endpoint ? session.credentials.key || '' : '';
}
const keyFor = (type, windowId) => `${type}:${windowId}`;
async function read(type, windowId) { const key = keyFor(type, windowId); return (await chrome.storage.session.get(key))[key]; }
async function write(type, windowId, value) { await chrome.storage.session.set({[keyFor(type, windowId)]: value}); }
async function status(windowId, message, error = false) { await write('status', windowId, {message, error, at: Date.now()}); }
async function preview(windowId, automatic = false) {
  const config = await settings();
  // A failed refresh must not leave an older, misleading preview actionable.
  await chrome.storage.session.remove(keyFor('preview',windowId));
  const current = await chrome.tabs.query({windowId});
  const tabs = eligibleTabs(current, config);
  if (!tabs.length) throw new Error('当前窗口没有符合条件的未分组标签。固定、隐身和排除域名会跳过。');
  const existingGroups = snapshotGroups(await chrome.tabGroups.query({windowId}), current, config, windowId);
  if (config.provider === 'api') {
    const {origin} = apiEndpoint(config.baseUrl);
    if (!await chrome.permissions.contains({origins: [origin]})) throw new Error('API 站点权限尚未授权，请打开设置重新保存。');
  }
  await status(windowId, '正在生成分类，请稍候…');
  const apiKey = await getKey(config);
  const groups = await makePlan(tabs, existingGroups, remaining => classify(remaining, config, {apiKey}));
  const result = {id:crypto.randomUUID(), revision:0, automatic, windowId, createdAt:Date.now(), groups, tabs, existingGroups, fingerprint:fingerprint(tabs), settingsFingerprint:JSON.stringify(config)};
  await write('preview', windowId, result);
  await status(windowId, groups.length ? `已生成 ${groups.length} 个组的预览，优先加入已有组。可调整目标后应用。` : '没有明确匹配的分组。可在下方为标签选择已有组，或保持原样。');
  return result;
}
async function apply(windowId, message = {}) {
  const value = await read('preview', windowId); const config = await settings();
  const previousUndo = await read('undo', windowId);
  if (previousUndo && previousUndo.phase !== 'complete') throw new Error('上次整理未完整结束，请先撤销恢复，再进行新的整理。');
  if (!value || typeof value.id !== 'string' || !Number.isInteger(value.revision) || message.previewId !== value.id || message.revision !== value.revision || JSON.stringify(config) !== value.settingsFingerprint) throw new Error('预览已更新，请刷新面板后检查新的预览。');
  if (!value.groups.length) throw new Error('预览中没有可应用的分组。');
  const result = await applyGroups(chrome, value, config, undo => write('undo', windowId, undo));
  await chrome.storage.session.remove(keyFor('preview', windowId));
  await status(windowId, `已整理 ${result.tabs} 个标签到 ${result.groups} 个组（${result.existing} 个已有组），可撤销。`);
  return result;
}
async function getState(windowId) {
  const config = await settings();
  const tabs = await chrome.tabs.query({windowId});
  const [value, undo, lastStatus] = await Promise.all(['preview','undo','status'].map(t => read(t, windowId)));
  return {settings: config, count: eligibleTabs(tabs,config).length, total: tabs.length, preview: value, canUndo: !!undo, status: lastStatus};
}
async function saveSettings(message) {
  await settingsReady;
  const config = normalizeSettings(message.settings);
  if (config.provider === 'api' && !await chrome.permissions.contains({origins:[apiEndpoint(config.baseUrl).origin]})) throw new Error('需要授权此 API 站点。');
  if (config.provider === 'siwc') {
    const account = await siwcStatus();
    if (!account.connected) throw new Error('尚未登录 ChatGPT。请在本机终端运行 ai-tab-companion login，再检查连接。');
    const {models, accountId} = await siwcModels();
    if (account.accountId !== accountId || config.siwcAccount !== accountId) throw new Error('ChatGPT 账户发生变化，请刷新连接、重新选择模型并确认数据发送同意。');
    if (!models.some(model => model.slug === config.siwcModel)) throw new Error('所选 ChatGPT 模型当前不可用。请重新检查连接并选择模型。');
  }
  let apiKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : await getKey(config);
  if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效。');
  const credentials = config.provider === 'api' && apiKey ? {key: apiKey, endpoint: apiEndpoint(config.baseUrl).endpoint} : null;
  // API keys are session-only. Never write them to persistent extension storage.
  await chrome.storage.session.set({credentials});
  await chrome.storage.local.set({settings: config});
  await chrome.storage.local.remove(['credentials','apiKey']);
  if (!config.auto) await chrome.alarms.clear('auto-organize');
  else await ensureAlarm();
  return {saved: true, hasKey: !!credentials};
}
async function handle(message) {
  switch(message.type) {
    case 'state': return getState(message.windowId);
    case 'siwcStatus': return siwcStatus();
    case 'siwcModels': return siwcModels();
    case 'settings': { const config = await settings(); return {settings: config, hasKey: !!await getKey(config)}; }
    case 'saveSettings': return serial(() => saveSettings(message));
    case 'clearKey': return serial(async () => { await chrome.storage.session.remove(['credentials','apiKey']); await chrome.storage.local.remove(['credentials','apiKey']); return {cleared:true}; });
    case 'preview': {
      if (previewsInFlight.has(message.windowId)) return previewsInFlight.get(message.windowId);
      const operation = serial(() => preview(message.windowId)).finally(() => previewsInFlight.delete(message.windowId));
      previewsInFlight.set(message.windowId, operation); return operation;
    }
    case 'editPreview': return serial(async () => {
      const value = await read('preview',message.windowId);
      if (!value || typeof value.id !== 'string' || !Number.isInteger(value.revision) || value.id !== message.previewId || value.revision !== message.revision) throw new Error('预览已更新，请刷新面板后重试。');
      if (Date.now()-value.createdAt > 10*60_000 || JSON.stringify(await settings()) !== value.settingsFingerprint) throw new Error('预览已过期或设置变化，请重新生成。');
      // Validate before merging, so duplicate tabs cannot be hidden by an edit.
      value.groups = mergeTargets(validatePlan(message.groups,value.tabs,value.existingGroups));
      value.revision++; await write('preview',message.windowId,value);
      await status(message.windowId,'预览已调整，尚未更改标签。'); return value;
    });
    case 'apply': return serial(() => apply(message.windowId,message));
    case 'undo': return serial(async () => {
      const undo = await read('undo', message.windowId); if (!undo) throw new Error('没有可撤销的操作。');
      const result = await undoGroups(chrome, undo);
      if (result.unresolved) throw new Error('部分已恢复，但中断时的分组成员已变化，无法安全自动解组。请手动取消该组后再次撤销；恢复记录已保留。');
      await chrome.storage.session.remove([keyFor('undo', message.windowId), keyFor('preview', message.windowId)]);
      // Undo also pauses automation to avoid immediately reapplying it.
      const config = await settings(); if (config.auto) { config.auto = false; await chrome.storage.local.set({settings:config}); await chrome.alarms.clear('auto-organize'); }
      await status(message.windowId, '已撤销可恢复的分组；自动整理已暂停。'); return result;
    });
    default: throw new Error('不支持的操作。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only this extension's own pages, never a web page or content script.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  handle(message).then(result => respond({ok:true,result})).catch(async error => {
    if (Number.isInteger(message.windowId)) await status(message.windowId, error.message, true).catch(() => {});
    respond({ok:false,error:error.message});
  });
  return true;
});
async function ensureAlarm() {
  if (!(await chrome.alarms.get('auto-organize'))) await chrome.alarms.create('auto-organize', {periodInMinutes: 1});
}
async function markPending(tab) {
  if (!tab || tab.incognito || !Number.isInteger(tab.windowId)) return;
  const config = await settings(); if (!config.auto) return;
  await write('pending', tab.windowId, {at: Date.now()}); await ensureAlarm();
}
chrome.tabs.onCreated.addListener(tab => { markPending(tab).catch(() => {}); });
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.status === 'complete') markPending(tab).catch(() => {}); });
chrome.windows.onRemoved.addListener(id => {
  chrome.storage.session.remove(['preview','undo','status','pending','lastAuto'].map(t => keyFor(t,id))).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'auto-organize') return;
  serial(async () => {
    const config = await settings(); if (!config.auto) return;
    const values = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith('pending:') || Date.now() - value.at < 15_000) continue;
      const windowId = Number(key.split(':')[1]);
      if (Date.now() - (values[keyFor('lastAuto',windowId)] || 0) < 5 * 60_000) continue;
      const pendingPreview = await read('preview',windowId);
      // Do not replace a manual preview while someone is reviewing/editing it.
      if (pendingPreview && !pendingPreview.automatic && Date.now()-pendingPreview.createdAt < 10*60_000) continue;
      await chrome.storage.session.remove(key);
      await write('lastAuto', windowId, Date.now());
      try {
        const undo = await read('undo', windowId);
        if (undo && undo.phase !== 'complete') throw new Error('上次整理被中断，请先撤销恢复。');
        const value = await preview(windowId,true);
        if (value.groups.length) await apply(windowId,{previewId:value.id,revision:value.revision});
        else await chrome.storage.session.remove(keyFor('preview',windowId));
      }
      catch(error) { await status(windowId, `自动整理暂停本次尝试：${error.message}`, true); }
    }
  }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { settings().then(s => s.auto && ensureAlarm()).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { settings().then(s => s.auto && ensureAlarm()).catch(() => {}); });
