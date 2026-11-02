import api, { route } from '@forge/api';
import { concernAllowed, followupConfirmation, validIssueId, validateDecision, nextState, pairKey } from '../lib/decisions';
import { claimTask, commitDecision, getPairState, queryRecords, pairConfirmed, PAIR_ENTITY, DECISION_ENTITY, readDecision, saveTaskMetadata } from './decisionStore';
import { matchCaptures } from '../lib/match';
import { issueCapture } from './evidence';
import { BudgetExceeded, checkJira, loadBudget } from './loadBudget';

const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
async function getIssue(id) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${id}?fields=summary,project&properties=qualityloop`, { headers });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return response.json();
}
async function canEdit(issueId) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/mypermissions?issueId=${issueId}&permissions=EDIT_ISSUES`, { headers });
  if ([403, 404].includes(response.status)) return false;
  checkJira(response);
  return (await response.json()).permissions?.EDIT_ISSUES?.havePermission === true;
}
async function canCreate(projectId) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/mypermissions?projectId=${projectId}&permissions=CREATE_ISSUES`, { headers });
  if ([403, 404].includes(response.status)) return false;
  checkJira(response);
  return (await response.json()).permissions?.CREATE_ISSUES?.havePermission === true;
}
async function displayName(accountId) {
  const response = await api.asUser().requestJira(route`/rest/api/3/user?accountId=${accountId}`, { headers });
  if ([403, 404].includes(response.status)) return 'User unavailable';
  checkJira(response);
  return (await response.json()).displayName || 'User unavailable';
}
const deniedEdit = () => ({ error: 'Editing needs edit permission on this issue.' });
const noCreateMessage = (project) => `Recorded. You can't create tasks in ${project}; ask the CAPA owner to review.`;

export function registerDecisionResolvers({ define, findMatches }) {
  define('getPanelAccess', [], async (issueId) => {
    if (!await getIssue(issueId)) return null;
    return { canEdit: await canEdit(issueId) };
  });

  define('recordDecision', ['capaId', 'expectedVersion', 'type', 'reason', 'reasonCategory', 'evidenceLinks'], async (issueId, payload, context) => {
    const fieldErrors = validateDecision(payload);
    if (Object.keys(fieldErrors).length) return { fieldErrors };
    // A payload identifier is re-authorised before it is used for any stored data.
    const capaIssue = await getIssue(payload.capaId);
    const currentIssue = await getIssue(issueId);
    if (!capaIssue || !currentIssue) return null;
    if (!await canEdit(issueId)) return deniedEdit();
    const authorAccountId = context?.accountId;
    if (typeof authorAccountId !== 'string' || !authorAccountId.trim()) return { error: 'Your account context is unavailable. Reopen the issue.' };
    const matches = matchCaptures(issueCapture(currentIssue), [issueCapture(capaIssue)]);
    const capa = [...(matches.strong ?? []), ...(matches.relatedRevision ?? [])].find(({ id }) => id === payload.capaId);
    if (!capa) return { error: 'This CAPA is no longer a strong or related revision match. Reload the evidence.' };
    // Check transition with the direct read again inside commitDecision, after the
    // version comparison; the transaction condition protects both checks from races.
    const previous = await getPairState(payload.capaId, issueId);
    if (previous.version !== payload.expectedVersion) return { conflict: true, pairState: previous };
    try { nextState(payload.type, previous.version ? previous : null, capa); }
    catch (error) { return { error: error.message }; }
    return commitDecision({ issueId, authorAccountId, payload, capa });
  });

  async function loadDecisionView(issueId, matches, budget, authorised) {
    const pairs = {};
    let incomplete = false;
    try {
      const readIssue = async (id) => {
        if (!authorised.has(id)) authorised.set(id, await budget.run(() => getIssue(id)));
        return authorised.get(id);
      };
      if (!await readIssue(issueId)) return null;
      const indexed = await queryRecords(PAIR_ENTITY, 'by-issue', issueId, { budget });
      incomplete = indexed.incomplete;
      const ids = new Set([...(matches.strong ?? []), ...(matches.relatedRevision ?? [])].map(({ id }) => id));
      for (const pair of indexed.records) if (pair.issueId === issueId && validIssueId(pair.capaId)) ids.add(pair.capaId);
      const names = new Map();
      for (const capaId of ids) {
        const capa = await readIssue(capaId);
        if (!capa) continue;
        const pairState = await budget.run(() => getPairState(capaId, issueId));
        const page = await queryRecords(DECISION_ENTITY, 'by-issue', issueId, { capaId, limit: 51, budget });
        let history = page.records.filter((record) => record.capaId === capaId && record.issueId === issueId);
        if (pairState.latestDecisionId && !history.some(({ id }) => id === pairState.latestDecisionId)) {
          const latest = await budget.run(() => readDecision(pairState.latestDecisionId));
          if (latest?.issueId === issueId && latest.capaId === capaId) history.push({ ...latest, id: pairState.latestDecisionId });
        }
        const historyIncomplete = page.incomplete || history.length > 50;
        history = history.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 50);
        const countPage = await queryRecords(PAIR_ENTITY, 'by-capa', capaId, { limit: 51, budget });
        let confirmedCount = 0;
        let confirmedCountIncomplete = countPage.incomplete;
        const seen = new Set();
        for (const record of countPage.records) {
          if (record.capaId !== capaId || !validIssueId(record.issueId) || seen.has(record.issueId)) continue;
          seen.add(record.issueId);
          if (!await readIssue(record.issueId)) continue;
          // Indexes discover pairs; direct state reads decide their current status.
          const state = await budget.run(() => getPairState(capaId, record.issueId));
          try { if (await pairConfirmed(state, capaId, record.issueId, budget)) confirmedCount += 1; }
          catch (error) {
            if (error instanceof BudgetExceeded) throw error;
            confirmedCountIncomplete = true;
          }
        }
        const publicHistory = [];
        for (const record of history) {
          if (!names.has(record.authorAccountId)) names.set(record.authorAccountId, await budget.run(() => displayName(record.authorAccountId)));
          let taskKey;
          if (record.taskKey && await readIssue(record.taskKey)) taskKey = record.taskKey;
          publicHistory.push({ id: record.id, type: record.type, reason: record.reason,
            reasonCategory: record.reasonCategory, evidenceLinks: record.evidenceLinks,
            createdAt: record.createdAt, authorDisplayName: names.get(record.authorAccountId), ...(taskKey ? { taskKey } : {}) });
        }
        pairs[capaId] = { pairState, history: publicHistory, historyIncomplete,
          confirmedCount: confirmedCount > 50 ? '50+' : confirmedCount, confirmedCountIncomplete,
          concernAllowed: concernAllowed(pairState, capa.properties?.qualityloop), capaKey: capa.key, capaSummary: capa.fields?.summary };
      }
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      incomplete = true;
    }
    return { pairs, incomplete };
  }
  async function loadEvidence(issueId) {
    const budget = loadBudget();
    const authorised = new Map();
    const matches = await findMatches(issueId, budget, authorised);
    if (!matches || matches.error) return matches;
    const decisions = await loadDecisionView(issueId, matches, budget, authorised);
    if (!decisions) return null;
    return { ...matches, pairs: decisions.pairs, decisionsIncomplete: decisions.incomplete,
      incomplete: !!matches.incomplete || decisions.incomplete };
  }
  define('loadEvidence', [], loadEvidence);
  // Compatibility alias: one search even for older clients.
  define('getDecisions', [], async (issueId) => {
    const result = await loadEvidence(issueId);
    return result && !result.error ? { pairs: result.pairs, incomplete: result.incomplete } : result;
  });
  async function taskContext(issueId, payload, context) {
    if (!validIssueId(payload.capaId)) return null;
    const prefix = `${pairKey(payload.capaId, issueId)}:`;
    if (typeof payload.decisionId !== 'string' || !payload.decisionId.startsWith(prefix) || payload.decisionId.length > 160) return null;
    const capa = await getIssue(payload.capaId);
    if (!capa || !await getIssue(issueId)) return null;
    if (!await canEdit(issueId)) return deniedEdit();
    const decision = await readDecision(payload.decisionId);
    if (!decision || decision.type !== 'CONCERN' || decision.capaId !== payload.capaId ||
        decision.issueId !== issueId || decision.authorAccountId !== context?.accountId) return null;
    const project = capa.fields?.project;
    if (!project?.id || !project.key) return { error: 'Recorded. The CAPA project could not be read.' };
    if (decision.taskClaimId) return { message: 'Recorded. Follow-up was already attempted; check the history and Jira before creating another task.' };
    if (!await canCreate(project.id)) return { message: noCreateMessage(project.key) };
    return { capa, decision, project, confirmation: followupConfirmation(project.key, capa.key) };
  }
  define('prepareConcernTask', ['capaId', 'decisionId'], async (issueId, payload, context) => {
    const result = await taskContext(issueId, payload, context);
    if (!result || result.error || result.message) return result;
    return { confirmation: result.confirmation };
  });

  define('createConcernTask', ['capaId', 'decisionId', 'confirmation'], async (issueId, payload, context) => {
    const result = await taskContext(issueId, payload, context);
    if (!result || result.error || result.message) return result;
    const { capa, decision, project, confirmation } = result;
    if (payload.confirmation !== confirmation) return { error: 'Recorded. The proposed write changed. Open the confirmation again.' };
    let claimed;
    let taskKey;
    try {
      // Resolve project-specific Task and site-specific relates-to IDs; never
      // assume issue type or link type numeric IDs are shared across Jira sites.
      let startAt = 0;
      let taskType;
      do {
        const response = await api.asUser().requestJira(
          route`/rest/api/3/issue/createmeta/${project.id}/issuetypes?startAt=${startAt}&maxResults=200`, { headers });
        if ([403, 404].includes(response.status)) return null;
        if (!response.ok) return { error: `Recorded. Task metadata could not be read (HTTP ${response.status}).` };
        const page = await response.json();
        taskType = page.issueTypes?.find((type) => type.name === 'Task' && !type.subtask);
        startAt += page.issueTypes?.length ?? 0;
        if (taskType || !page.issueTypes?.length || startAt >= page.total) break;
      } while (true);
      if (!taskType) return { error: `Recorded. No standard Task type is available in ${project.key}. Ask the CAPA owner to review.` };
      const linksResponse = await api.asUser().requestJira(route`/rest/api/3/issueLinkType`, { headers });
      if (!linksResponse.ok) return { error: `Recorded. Link types could not be read (HTTP ${linksResponse.status}).` };
      const linkType = (await linksResponse.json()).issueLinkTypes?.find((type) =>
        type.inward?.toLowerCase() === 'relates to' && type.outward?.toLowerCase() === 'relates to');
      if (!linkType) return { error: 'Recorded. The relates to link type is unavailable. Ask the CAPA owner to review.' };
      // Re-authorise after metadata reads, before claiming and writing.
      const freshCapa = await getIssue(payload.capaId);
      if (!freshCapa || !await getIssue(issueId)) return null;
      if (freshCapa.fields?.project?.id !== project.id || freshCapa.key !== capa.key) {
        return { error: 'Recorded. The CAPA project or key changed. Open a new follow-up confirmation.' };
      }
      if (!await canEdit(issueId)) return deniedEdit();
      if (!await canCreate(project.id)) return { message: noCreateMessage(project.key) };
      claimed = await claimTask(payload.decisionId, decision);
      if (!claimed) return { message: 'Recorded. Follow-up was already attempted; check Jira before creating another task.' };
      const response = await api.asUser().requestJira(route`/rest/api/3/issue`, {
        method: 'POST', headers, body: JSON.stringify({ fields: {
          project: { id: project.id }, issuetype: { id: taskType.id }, summary: `Effectiveness re-review: ${capa.key}`,
        } }),
      });
      if ([403, 404].includes(response.status)) return null;
      if (!response.ok) return { error: `Recorded. Task creation returned HTTP ${response.status}. Check Jira before trying another follow-up.` };
      const task = await response.json();
      taskKey = task.key;
      await saveTaskMetadata(payload.decisionId, { ...claimed, taskKey });
      // The server-generated task ID is still checked asUser before linking.
      if (!await getIssue(task.id) || !await getIssue(payload.capaId)) return null;
      const linked = await api.asUser().requestJira(route`/rest/api/3/issueLink`, {
        method: 'POST', headers, body: JSON.stringify({ type: { id: linkType.id },
          outwardIssue: { id: task.id }, inwardIssue: { id: capa.id } }),
      });
      if (!linked.ok) return { error: 'Recorded. Follow-up linking could not finish. Check Jira before creating another task.' };
      return { message: `Recorded. Created ${taskKey} and linked it to ${capa.key}.` };
    } catch {
      console.error('QualityLoop concern follow-up failed.');
      return { error: 'Recorded. Follow-up could not finish. Check Jira before creating another task.' };
    }
  });
}
