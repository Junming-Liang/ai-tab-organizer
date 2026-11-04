// All browser mutations live here so the same safety checks are unit-testable.
import {eligibleTabs, fingerprint} from './core.js';
import {snapshotGroups, groupFingerprint, sameGroup, validatePlan} from './planning.js';
async function readGroups(api, windowId, settings, tabs) {
  return snapshotGroups(await api.tabGroups.query({windowId}), tabs || await api.tabs.query({windowId}), settings, windowId);
}
export async function applyGroups(api, preview, settings, saveUndo) {
  const current = await api.tabs.query({windowId: preview.windowId});
  if (Date.now() - preview.createdAt > 10 * 60_000 || fingerprint(eligibleTabs(current, settings)) !== preview.fingerprint) {
    throw new Error('标签或设置已变化，或预览已过期。请重新生成预览。');
  }
  const candidates = preview.tabs || eligibleTabs(current, settings);
  const groups = validatePlan(preview.groups, candidates, preview.existingGroups || []);
  let expectedGroups = preview.existingGroups;
  if (expectedGroups && groupFingerprint(await readGroups(api, preview.windowId, settings, current)) !== groupFingerprint(expectedGroups)) throw new Error('已有分组已变化，请重新生成预览。');
  const undo = {
    version:2, windowId:preview.windowId, createdAt:Date.now(), phase:'prepared', pending:null,
    originalGroupIds:[...new Set(current.map(t => t.groupId).filter(id => id >= 0))],
    order:current.map(t => ({id:t.id, index:t.index, pinned:!!t.pinned, groupId:t.groupId})),
    affected:groups.flatMap(g => g.tabIds), createdGroupIds:[], assignments:[],
  };
  // Persist the exact intended destination BEFORE each mutation. Existing members
  // are never part of affected/assignments, including during crash recovery.
  await saveUndo(undo);
  let mutationAttempted = false;
  try {
    for (const group of groups) {
      mutationAttempted = false;
      undo.phase = 'applying';
      undo.pending = {tabIds:[...group.tabIds], targetGroupId:group.targetGroupId ?? null};
      await saveUndo(undo);
      const live = await Promise.all(group.tabIds.map(id => api.tabs.get(id)));
      const expected = candidates.filter(tab => group.tabIds.includes(tab.id));
      if (live.some(tab => tab.windowId !== preview.windowId) || fingerprint(eligibleTabs(live, settings)) !== fingerprint(expected)) throw new Error('整理期间标签发生变化。');
      if (expectedGroups && groupFingerprint(await readGroups(api, preview.windowId, settings)) !== groupFingerprint(expectedGroups)) throw new Error('整理期间已有组发生变化。');
      mutationAttempted = true;
      const groupId = group.targetGroupId == null
        ? await api.tabs.group({tabIds:group.tabIds, createProperties:{windowId:preview.windowId}})
        : await api.tabs.group({tabIds:group.tabIds, groupId:group.targetGroupId});
      if (group.targetGroupId == null) undo.createdGroupIds.push(groupId);
      undo.assignments.push({groupId, tabIds:[...group.tabIds]});
      undo.pending = null; await saveUndo(undo);
      // Existing group title/color/collapse are deliberately never updated.
      if (group.targetGroupId == null) await api.tabGroups.update(groupId, {title:group.title, color:group.color, collapsed:false});
      const grouped = await Promise.all(group.tabIds.map(id => api.tabs.get(id)));
      if (grouped.some(tab => tab.windowId !== preview.windowId || tab.groupId !== groupId || tab.pinned)) throw new Error('整理期间标签发生变化。');
      if (expectedGroups) {
        const after = await readGroups(api, preview.windowId, settings);
        if (expectedGroups.some(before => !sameGroup(before, after.find(item => item.id === before.id), before.id === group.targetGroupId ? group.tabIds : []))
          || after.length !== expectedGroups.length + (group.targetGroupId == null ? 1 : 0)) throw new Error('整理期间已有组发生变化。');
        expectedGroups = after;
      }
    }
    undo.phase = 'complete'; await saveUndo(undo);
    return {groups:groups.length, tabs:undo.affected.length, existing:groups.filter(group => group.targetGroupId != null).length};
  } catch {
    // A failed preflight is known not to have grouped anything this round. Do
    // not later mistake a user's concurrent manual move for our own mutation.
    if (!mutationAttempted) { undo.pending = null; await saveUndo(undo); }
    throw new Error('整理未全部完成。已保存撤销记录，请点击「撤销」恢复后重试。');
  }
}
export async function undoGroups(api, undo) {
  const current = await api.tabs.query({windowId:undo.windowId});
  const surviving = new Map(current.map(t => [t.id,t]));
  const destinations = new Map();
  if (undo.assignments) {
    for (const assignment of undo.assignments) for (const id of assignment.tabIds) destinations.set(id, assignment.groupId);
  } else {
    // Backwards-compatible recovery of an operation made before this upgrade.
    for (const id of undo.affected) if (undo.createdGroupIds.includes(surviving.get(id)?.groupId)) destinations.set(id, surviving.get(id).groupId);
  }
  let unresolved = false;
  const pending = Array.isArray(undo.pending) ? {tabIds:undo.pending,targetGroupId:null} : undo.pending;
  if (pending?.tabIds.length) {
    if (pending.targetGroupId != null) {
      for (const id of pending.tabIds) if (surviving.get(id)?.groupId === pending.targetGroupId) destinations.set(id,pending.targetGroupId);
    } else {
      const tabs = pending.tabIds.map(id => surviving.get(id));
      const candidate = tabs[0]?.groupId;
      const members = current.filter(tab => tab.groupId === candidate).map(tab => tab.id);
      if (candidate >= 0 && !undo.originalGroupIds.includes(candidate) && tabs.every(tab => tab?.groupId === candidate) && members.length === pending.tabIds.length && members.every(id => pending.tabIds.includes(id))) {
        for (const id of pending.tabIds) destinations.set(id,candidate);
      } else if (tabs.some(tab => tab && tab.groupId >= 0 && !undo.originalGroupIds.includes(tab.groupId))) unresolved = true;
    }
  }
  const restored = new Set();
  // Re-read immediately before each mutation; never pull a moved, pinned or
  // manually regrouped tab back, and never ungroup an original group member.
  for (const id of undo.affected) {
    if (!destinations.has(id)) continue;
    const tab = await api.tabs.get(id).catch(() => null);
    if (tab?.windowId === undo.windowId && !tab.pinned && tab.groupId === destinations.get(id)) {
      await api.tabs.ungroup([id]); restored.add(id);
    }
  }
  // Only move tabs actually restored by this undo, not unrelated ungrouped tabs.
  for (const item of undo.order.filter(t => restored.has(t.id) && (t.groupId === -1 || t.groupId == null)).sort((a,b) => a.index-b.index)) {
    const tab = await api.tabs.get(item.id).catch(() => null);
    if (tab?.windowId === undo.windowId && tab.groupId === -1 && !tab.pinned) await api.tabs.move(item.id,{index:item.index});
  }
  return {tabs:restored.size, unresolved};
}
