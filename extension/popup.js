const $ = id => document.getElementById(id);
let windowId; let busy = false;
async function request(type) {
  const response = await chrome.runtime.sendMessage({type,windowId});
  if (!response?.ok) throw new Error(response?.error || '后台暂未响应，请重试。');
  return response.result;
}
function showStatus(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function refresh() {
  const state = await request('state');
  $('count').textContent = state.count;
  $('engine').textContent = `${state.settings.provider === 'local' ? '本地规则 · 不联网' : 'AI · 标题 + 域名'}${state.settings.auto ? ' · 自动' : ''}`;
  $('apply').disabled = busy || !state.preview?.groups?.length;
  $('undo').disabled = busy || !state.canUndo;
  $('preview').disabled = busy || state.count < 2;
  const groups = state.preview?.groups || [];
  $('preview-section').hidden = !groups.length;
  $('groups').replaceChildren();
  for (const group of groups) {
    const card = document.createElement('div'); card.className = 'group';
    const heading = document.createElement('div'); heading.className = 'group-header';
    const dot = document.createElement('span'); dot.className = `dot ${group.color}`;
    const name = document.createElement('strong'); name.textContent = group.title;
    const amount = document.createElement('span'); amount.className = 'badge'; amount.textContent = group.tabIds.length;
    heading.append(dot,name,amount); card.append(heading);
    const list = document.createElement('ul');
    for (const id of group.tabIds) {
      const tab = state.preview.tabs.find(t => t.id === id); const item = document.createElement('li');
      item.textContent = tab?.title || tab?.domain || '标签已关闭'; list.append(item);
    }
    card.append(list); $('groups').append(card);
  }
  if (state.status) showStatus(state.status.message,state.status.error);
  else showStatus('先看分类，再决定是否应用。第一次使用也可以离线体验。');
}
async function run(type) {
  if (busy) return; busy = true;
  for (const id of ['preview','apply','undo']) $(id).disabled = true;
  showStatus(type === 'preview' ? '正在生成分类…关闭面板也可继续，稍后重新打开查看。' : '正在处理…');
  try { await request(type); } catch(error) { showStatus(error.message,true); }
  finally { busy = false; await refresh().catch(error => showStatus(error.message,true)); }
}
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
for (const id of ['preview','apply','undo']) $(id).addEventListener('click', () => run(id));
try { windowId = (await chrome.windows.getCurrent()).id; await refresh(); }
catch(error) { showStatus(error.message,true); }
