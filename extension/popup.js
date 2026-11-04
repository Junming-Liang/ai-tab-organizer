const $ = id => document.getElementById(id);
let windowId; let busy = false; let currentPreview;
async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({type,windowId,...extra});
  if (!response?.ok) throw new Error(response?.error || '后台暂未响应，请重试。');
  return response.result;
}
function showStatus(message,error = false) { $('status').textContent = message; $('status').classList.toggle('error',error); }
const groupName = group => group.title || `未命名组 #${group.id ?? group.targetGroupId}`;
function targetSelect(group, existingGroups) {
  const select = document.createElement('select'); select.className = 'target-select'; select.setAttribute('aria-label','分组目标');
  const skip = document.createElement('option'); skip.value='skip'; skip.textContent='保持未分组'; select.append(skip);
  if (group.tabIds.length >= 2) { const option = document.createElement('option'); option.value='new'; option.textContent='新建分组'; select.append(option); }
  for (const target of existingGroups) {
    const option = document.createElement('option'); option.value=String(target.id); option.textContent=`加入已有组：${groupName(target)} · #${target.id}`; select.append(option);
  }
  select.value=group.targetGroupId == null ? 'new' : String(group.targetGroupId);
  return select;
}
async function edit(groups) {
  if (busy || !currentPreview) return;
  const {id,revision} = currentPreview;
  busy=true; setBusy();
  try { await request('editPreview',{previewId:id,revision,groups}); }
  catch(error) { showStatus(error.message,true); }
  finally { busy=false; await refresh().catch(error => showStatus(error.message,true)); }
}
function setBusy() { for (const node of document.querySelectorAll('#preview,#apply,#undo,.target-select,.group-name,.tab-include')) node.disabled=busy; }
async function refresh() {
  const state = await request('state'); currentPreview=state.preview;
  $('count').textContent=state.count;
  $('engine').textContent=`${state.settings.provider === 'local' ? '本地规则 · 不联网' : state.settings.provider === 'siwc' ? 'ChatGPT / SIWC · 共享计划额度' : 'API · 标题 + 域名'}${state.settings.auto ? ' · 自动' : ''}`;
  $('apply').disabled=busy || !state.preview?.groups?.length;
  $('undo').disabled=busy || !state.canUndo;
  $('preview').disabled=busy || state.count < 1;
  const preview=state.preview; const groups=preview?.groups || [];
  $('preview-section').hidden=!preview;
  $('groups').replaceChildren(); $('unassigned').replaceChildren();
  groups.forEach((group,index) => {
    const card=document.createElement('div'); card.className='group';
    const heading=document.createElement('div'); heading.className='group-header';
    const dot=document.createElement('span'); dot.className=`dot ${group.color}`;
    const name=document.createElement('strong'); name.textContent=groupName(group);
    const amount=document.createElement('span'); amount.className='badge'; amount.textContent=`${group.targetGroupId == null ? '新建' : '加入已有'} · ${group.tabIds.length} 个`;
    heading.append(dot,name,amount); card.append(heading);
    const target=targetSelect(group,preview.existingGroups || []); card.append(target);
    target.addEventListener('change',() => {
      const next=structuredClone(groups);
      if (target.value === 'skip') next.splice(index,1);
      else if (target.value === 'new') { delete next[index].targetGroupId; next[index].title=group.title || '新分组'; }
      else next[index].targetGroupId=Number(target.value);
      edit(next);
    });
    if (group.targetGroupId == null) {
      const input=document.createElement('input'); input.className='group-name'; input.maxLength=40; input.value=group.title; input.setAttribute('aria-label','新组名称'); card.append(input);
      input.addEventListener('change',() => { const next=structuredClone(groups); next[index].title=input.value; edit(next); });
    }
    const list=document.createElement('ul');
    for (const id of group.tabIds) {
      const tab=preview.tabs.find(t => t.id === id); const item=document.createElement('li');
      const label=document.createElement('label'); const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=true; checkbox.className='tab-include';
      const text=document.createElement('span'); text.textContent=tab?.title || tab?.domain || '标签已关闭';
      label.append(checkbox,text); item.append(label); list.append(item);
      checkbox.addEventListener('change',() => {
        const next=structuredClone(groups); next[index].tabIds=next[index].tabIds.filter(tabId => tabId !== id);
        if (next[index].tabIds.length < (next[index].targetGroupId == null ? 2 : 1)) next.splice(index,1);
        edit(next);
      });
    }
    card.append(list); $('groups').append(card);
  });
  const used=new Set(groups.flatMap(group => group.tabIds));
  const remaining=(preview?.tabs || []).filter(tab => !used.has(tab.id));
  $('unassigned-section').hidden=!remaining.length;
  for (const tab of remaining) {
    const row=document.createElement('div'); row.className='unassigned-tab'; row.dataset.tabId=tab.id;
    const label=document.createElement('span'); label.textContent=tab.title || tab.domain;
    const select=targetSelect({tabIds:[tab.id]},preview.existingGroups || []); select.value='skip';
    select.addEventListener('change',() => { if (select.value !== 'skip') edit([...groups,{targetGroupId:Number(select.value),tabIds:[tab.id]}]); });
    row.append(label,select); $('unassigned').append(row);
  }
  if (state.status) showStatus(state.status.message,state.status.error);
  else showStatus('先看分类，再决定是否应用。一个新标签也可以加入已有组。');
}
async function run(type) {
  if (busy) return; busy=true; setBusy();
  showStatus(type === 'preview' ? '正在生成分类…关闭面板也可继续，稍后重新打开查看。' : '正在处理…');
  const identity=currentPreview ? {previewId:currentPreview.id,revision:currentPreview.revision} : {};
  try { await request(type,identity); } catch(error) { showStatus(error.message,true); }
  finally { busy=false; await refresh().catch(error => showStatus(error.message,true)); }
}
$('settings').addEventListener('click',() => chrome.runtime.openOptionsPage());
for (const id of ['preview','apply','undo']) $(id).addEventListener('click',() => run(id));
try { windowId=(await chrome.windows.getCurrent()).id; await refresh(); }
catch(error) { showStatus(error.message,true); }
