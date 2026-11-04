// Existing-group context stays on this device. Only ungrouped candidates reach a provider.
import {COLORS, cleanText, eligibleTabs, localBuckets} from './core.js';
const normalized = value => cleanText(value, 200).normalize('NFKC').toLocaleLowerCase();
const aliases = new Map([
  ['development','开发'], ['dev','开发'], ['coding','开发'], ['research','研究'],
  ['work','工作'], ['shopping','购物'], ['entertainment','娱乐'], ['reading','阅读'],
]);
const topicName = title => aliases.get(normalized(title)) || normalized(title);
export function snapshotGroups(groups, tabs, settings, windowId) {
  return groups.filter(group => group.windowId === windowId && !group.shared && Number.isInteger(group.id))
    .map(group => {
      const members = tabs.filter(tab => tab.groupId === group.id && tab.windowId === windowId).sort((a,b) => a.index-b.index);
      // Apply the same privacy exclusions before using member domains as local hints.
      const hints = eligibleTabs(members.map(tab => ({...tab, groupId:-1})), settings);
      return {id:group.id, windowId, title:group.title || '', color:group.color, collapsed:!!group.collapsed,
        tabIds:members.map(tab => tab.id), domains:[...new Set(hints.map(tab => tab.domain))].sort()};
    }).filter(group => group.tabIds.length).sort((a,b) => a.id-b.id);
}
export function groupFingerprint(groups) {
  return JSON.stringify(groups.map(({id,windowId,title,color,collapsed,tabIds,domains}) => ({id,windowId,title,color,collapsed,tabIds,domains})).sort((a,b) => a.id-b.id));
}
export function sameGroup(before, after, added = []) {
  return !!after && after.id === before.id && after.windowId === before.windowId && !after.shared
    && (after.title || '') === before.title && after.color === before.color && !!after.collapsed === before.collapsed
    && after.tabIds.length === before.tabIds.length + added.length
    && before.tabIds.every(id => after.tabIds.includes(id)) && added.every(id => after.tabIds.includes(id))
    && after.tabIds.filter(id => before.tabIds.includes(id)).every((id,index) => id === before.tabIds[index]);
}
function unique(items) { return items.length === 1 ? items[0] : null; }
export function matchExisting(tab, groups) {
  const bucket = localBuckets([tab])[0];
  const named = groups.filter(group => group.title && topicName(group.title) === topicName(bucket.title));
  const domain = groups.filter(group => group.domains.includes(tab.domain));
  // A domain shared by several projects is ambiguous. Never pick the first group arbitrarily.
  if (named.length && domain.length) return unique(named.filter(group => domain.some(candidate => candidate.id === group.id))) || (domain.length === 1 ? domain[0] : null);
  if (domain.length) return unique(domain);
  return unique(named);
}
export function mergeTargets(groups) {
  const output = [];
  for (const group of groups) {
    const existing = group.targetGroupId == null ? null : output.find(item => item.targetGroupId === group.targetGroupId);
    if (existing) existing.tabIds.push(...group.tabIds);
    else output.push({...group, tabIds:[...group.tabIds]});
  }
  return output;
}
export async function makePlan(tabs, existingGroups, classifyRemaining) {
  const matched = []; const remaining = [];
  for (const tab of tabs) {
    const group = matchExisting(tab, existingGroups);
    if (group) matched.push({title:group.title, color:group.color, targetGroupId:group.id, tabIds:[tab.id]});
    else remaining.push(tab);
  }
  // Never make an otherwise pointless API request for a lone unmatched tab.
  const proposals = remaining.length >= 2 ? await classifyRemaining(remaining) : [];
  for (const proposal of proposals) {
    const destination = unique(existingGroups.filter(group => group.title && topicName(group.title) === topicName(proposal.title)));
    matched.push({...proposal, ...(destination ? {title:destination.title, color:destination.color, targetGroupId:destination.id} : {})});
  }
  return validatePlan(mergeTargets(matched), tabs, existingGroups);
}
export function validatePlan(groups, tabs, existingGroups) {
  if (!Array.isArray(groups) || groups.length > 100) throw new Error('预览分组格式无效。');
  const known = new Set(tabs.map(tab => tab.id)); const used = new Set();
  return groups.map((group,index) => {
    const target = group?.targetGroupId == null ? null : existingGroups.find(item => item.id === group.targetGroupId);
    if (group?.targetGroupId != null && !target) throw new Error('目标组不在当前预览中，请重新生成预览。');
    if (!group || !Array.isArray(group.tabIds) || group.tabIds.length < (target ? 1 : 2)) throw new Error('新组至少需要两个标签；一个标签也可以加入已有组。');
    for (const id of group.tabIds) {
      if (!Number.isInteger(id) || !known.has(id) || used.has(id)) throw new Error('预览包含未知或重复标签，没有更改浏览器。');
      used.add(id);
    }
    if (target) return {title:target.title, color:target.color, targetGroupId:target.id, tabIds:[...group.tabIds]};
    const title = typeof group.title === 'string' ? cleanText(group.title,40) : '';
    if (!title) throw new Error('请为新组填写名称。');
    return {title, color:COLORS.includes(group.color) ? group.color : COLORS[index % COLORS.length], tabIds:[...group.tabIds]};
  });
}
