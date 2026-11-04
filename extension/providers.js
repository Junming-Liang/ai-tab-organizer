import { SYSTEM_PROMPT, apiEndpoint, parseModelJson, toPayload, validateGroups, localGroups } from './core.js';
import { nativeRequest, validSiwcModel, validSiwcAccount } from './siwc.js';
export async function classify(tabs, settings, {apiKey = '', fetcher = fetch, nativeRequester = nativeRequest} = {}) {
  if (settings.provider === 'local') return localGroups(tabs);
  if (settings.provider === 'siwc') {
    if (!settings.siwcConsent) throw new Error('请先在设置中单独确认 ChatGPT 数据发送范围及共享计划额度。');
    if (!validSiwcAccount(settings.siwcAccount)) throw new Error('请检查连接并重新确认 ChatGPT 账户。');
    if (!validSiwcModel(settings.siwcModel)) throw new Error('请检查连接并选择有效的 ChatGPT 模型。');
    const result = await nativeRequester('classify', {accountId: settings.siwcAccount, model: settings.siwcModel, categories: settings.categories, tabs: toPayload(tabs)});
    return validateGroups(result, tabs);
  }
  if (settings.provider !== 'api') throw new Error('未知分类引擎。');
  if (!settings.consent) throw new Error('请先在设置中确认 AI 数据发送范围。');
  if (!apiKey) throw new Error('请在设置中填写 API Key。浏览器重启后，会话 Key 需要重新填写。');
  const {endpoint} = apiEndpoint(settings.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetcher(endpoint, {
      method: 'POST', signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
      body: JSON.stringify({model: settings.model, messages: [
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: JSON.stringify({categories: settings.categories, tabs: toPayload(tabs)})},
      ], response_format: {type: 'json_object'}, stream: false}),
    });
    if (!response.ok) throw new Error(`API 请求失败（HTTP ${response.status}）。请检查地址、Key、额度和模型的 JSON 支持。`);
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder(); let size = 0;
      while (true) {
        const {done, value} = await reader.read(); if (done) break;
        size += value.length;
        if (size > 256_000) { await reader.cancel(); throw new Error('API 响应过大。'); }
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } else text = await response.text();
    if (text.length > 256_000) throw new Error('API 响应过大。');
    let data; try { data = JSON.parse(text); } catch { throw new Error('API 返回内容不是 JSON。'); }
    return validateGroups(parseModelJson(data?.choices?.[0]?.message?.content), tabs);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('API 超过 25 秒未完成，未改动标签。可换用响应更快的模型。');
    if (error instanceof TypeError) throw new Error('无法连接 API。请检查服务地址、网络、权限或重定向设置。');
    throw error;
  } finally { clearTimeout(timeout); }
}
