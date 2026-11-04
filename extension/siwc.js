import { cleanText, toPayload } from './core.js';

export const SIWC_HOST = 'com.ai_tab_organizer.siwc';
export const SIWC_TIMEOUT_MS = 90_000;
const UNAVAILABLE = '无法连接独立 ChatGPT companion。请先安装并注册本机 companion；登录请在本机终端运行 ai-tab-companion login。';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function validSiwcAccount(value) { return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value); }
export function validSiwcModel(value) { return typeof value === 'string' && MODEL_PATTERN.test(value); }

function safeHostError(value) {
  // Never expose raw transport errors or accidentally relay credentials/URLs.
  if (typeof value !== 'string' || !/[\u3400-\u9fff]/.test(value) || /https?:|bearer|token|secret|sk-|eyJ[A-Za-z0-9_-]{12}/i.test(value)) return 'ChatGPT companion 请求失败。请检查本机登录状态、网络和共享额度后重试。';
  return cleanText(value, 240);
}

function requestPayload(type, payload) {
  if (type === 'status' || type === 'models') return {};
  if (type !== 'classify') throw new Error('不支持的 companion 操作。');
  if (!validSiwcAccount(payload.accountId)) throw new Error('请检查连接并重新确认 ChatGPT 账户。');
  if (!validSiwcModel(payload.model)) throw new Error('请检查连接并选择有效的 ChatGPT 模型。');
  if (!Array.isArray(payload.tabs) || payload.tabs.length > 100) throw new Error('标签数据无效。');
  return {accountId: payload.accountId, model: payload.model, categories: cleanText(payload.categories, 300), tabs: toPayload(payload.tabs)};
}

export async function nativeRequest(type, payload = {}, {chromeApi = globalThis.chrome, timeoutMs = SIWC_TIMEOUT_MS} = {}) {
  const input = requestPayload(type, payload);
  if (!chromeApi?.permissions?.contains || !await chromeApi.permissions.contains({permissions: ['nativeMessaging']})) {
    throw new Error('尚未授权本机 companion 连接。请在设置中点击 Continue with ChatGPT。');
  }
  if (!chromeApi.runtime?.connectNative) throw new Error(UNAVAILABLE);
  const id = globalThis.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let port; let timer; let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (port) {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        try { port.disconnect(); } catch { /* Already disconnected. */ }
      }
      if (error) reject(error); else resolve(result);
    };
    const onMessage = message => {
      if (!message || typeof message !== 'object' || message.id !== id) return;
      if (message.ok === false) return finish(new Error(safeHostError(message.error)));
      if (message.ok !== true || !message.result || typeof message.result !== 'object') return finish(new Error('ChatGPT companion 返回了无效响应。'));
      finish(null, message.result);
    };
    const onDisconnect = () => {
      // Read lastError to consume Chrome's error without showing local paths.
      void chromeApi.runtime.lastError;
      finish(new Error(UNAVAILABLE));
    };
    try {
      port = chromeApi.runtime.connectNative(SIWC_HOST);
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      timer = setTimeout(() => finish(new Error('ChatGPT companion 超过 90 秒未完成，未改动标签。请稍后重试。')), timeoutMs);
      port.postMessage({id, type, ...input});
    } catch { finish(new Error(UNAVAILABLE)); }
  });
}

export async function siwcStatus(requester = nativeRequest) {
  const result = await requester('status');
  if (typeof result?.connected !== 'boolean') throw new Error('ChatGPT companion 登录状态无效。');
  // Do not pass through additional host fields or credentials to extension pages.
  if (!result.connected) return {connected:false};
  if (!validSiwcAccount(result.accountId)) throw new Error('ChatGPT companion 账户标识无效。请更新 companion 并检查连接。');
  return {connected:true, accountId:result.accountId, account:cleanText(result.account, 120)};
}

export async function siwcModels(requester = nativeRequest) {
  const result = await requester('models');
  if (!validSiwcAccount(result?.accountId)) throw new Error('ChatGPT companion 账户标识无效。请更新 companion 并检查连接。');
  if (!Array.isArray(result?.models) || result.models.length > 200) throw new Error('ChatGPT companion 模型列表无效。');
  const seen = new Set();
  const models = result.models.map(model => {
    if (!model || !validSiwcModel(model.slug) || seen.has(model.slug)) throw new Error('ChatGPT companion 模型列表无效。');
    seen.add(model.slug);
    return {slug: model.slug, display_name: cleanText(model.display_name || model.slug, 120)};
  });
  if (!models.length) throw new Error('当前 ChatGPT 账号没有可用模型。请检查计划支持、登录状态或稍后重试。');
  return {models, accountId:result.accountId, account:cleanText(result.account, 120)};
}
