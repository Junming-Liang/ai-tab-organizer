// All browser mutations live here so the same safety checks are unit-testable.
import { eligibleTabs, fingerprint } from './core.js';
export async function applyGroups(api, preview, settings, saveUndo) {
  const current = await api.tabs.query({windowId: preview.windowId});
  if (Date.now() - preview.createdAt > 10 * 60_000 || fingerprint(eligibleTabs(current, settings)) !== preview.fingerprint) {
    throw new Error('标签或设置已变化，或预览已过期。请重新生成预览。');
  }
  const undo = {
    windowId: preview.windowId, createdAt: Date.now(), phase: 'prepared', pending: null,
    originalGroupIds: [...new Set(current.map(t => t.groupId).filter(id => id >= 0))],
    order: current.map(t => ({id: t.id, index: t.index, pinned: !!t.pinned, groupId: t.groupId})),
    affected: preview.groups.flatMap(g => g.tabIds), createdGroupIds: [],
  };
  // Persist BEFORE mutation so interruption/partial failure remains undoable.
  await saveUndo(undo);
  try {
    for (const group of preview.groups) {
      // A user may change tabs while Chrome calls are in flight.
      const live = await Promise.all(group.tabIds.map(id => api.tabs.get(id)));
      const expected = preview.tabs?.filter(tab => group.tabIds.includes(tab.id)) || eligibleTabs(current, settings).filter(tab => group.tabIds.includes(tab.id));
      if (live.some(tab => tab.windowId !== preview.windowId) || fingerprint(eligibleTabs(live, settings)) !== fingerprint(expected)) throw new Error('整理期间标签发生变化，请撤销后重新预览。');
      undo.phase = 'applying'; undo.pending = [...group.tabIds]; await saveUndo(undo);
      const groupId = await api.tabs.group({tabIds: group.tabIds, createProperties: {windowId: preview.windowId}});
      undo.createdGroupIds.push(groupId); undo.pending = null; await saveUndo(undo);
      await api.tabGroups.update(groupId, {title: group.title, color: group.color, collapsed: false});
    }
    undo.phase = 'complete'; await saveUndo(undo);
    return {groups: preview.groups.length, tabs: undo.affected.length};
  } catch {
    throw new Error('整理未全部完成。已保存撤销记录，请点击「撤销」恢复后重试。');
  }
}
export async function undoGroups(api, undo) {
  const current = await api.tabs.query({windowId: undo.windowId});
  const surviving = new Map(current.map(t => [t.id, t]));
  const affected = undo.affected.filter(id => surviving.has(id) && !surviving.get(id).pinned);
  // Avoid pulling tabs out of a manually created/different group after organization.
  const createdGroupIds = [...undo.createdGroupIds];
  let unresolved = false;
  // Recover the narrow crash window after Chrome creates a group but before the
  // returned group ID is saved. Require exact intended membership in a new group.
  if (undo.pending?.length) {
    const pending = undo.pending.map(id => surviving.get(id));
    const candidate = pending[0]?.groupId;
    const members = current.filter(tab => tab.groupId === candidate).map(tab => tab.id);
    if (candidate >= 0 && !undo.originalGroupIds.includes(candidate) && pending.every(tab => tab?.groupId === candidate) && members.length === undo.pending.length && members.every(id => undo.pending.includes(id))) createdGroupIds.push(candidate);
    else if (pending.some(tab => tab && tab.groupId >= 0 && !undo.originalGroupIds.includes(tab.groupId))) unresolved = true;
  }
  const owned = affected.filter(id => createdGroupIds.includes(surviving.get(id).groupId));
  if (owned.length) await api.tabs.ungroup(owned);
  const order = undo.order.filter(t => (t.groupId === -1 || t.groupId == null) && surviving.has(t.id) && !surviving.get(t.id).pinned).sort((a,b) => a.index-b.index);
  // Moving individual tabs within existing groups can disturb those groups. Restore
  // only original ungrouped tabs; user's pre-existing groups are never touched.
  for (const item of order) {
    const tab = await api.tabs.get(item.id).catch(() => null);
    if (tab && tab.windowId === undo.windowId && tab.groupId === -1 && !tab.pinned) await api.tabs.move(item.id, {index: item.index});
  }
  return {tabs: owned.length, unresolved};
}
