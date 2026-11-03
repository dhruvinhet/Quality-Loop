import api, { route } from '@forge/api';
import { concernAllowed, followupConfirmation, validIssueId, validateDecision, nextState, pairKey } from '../lib/decisions';
import { claimTask, commitDecision, getPairState, queryRecords, pairConfirmed, PAIR_ENTITY, DECISION_ENTITY, readDecision, saveTaskMetadata, saveTaskLinked } from './decisionStore';
import { matchCaptures } from '../lib/match';
import { issueCapture } from './evidence';
import { BudgetExceeded, checkJira, loadBudget } from './loadBudget';
import { FOLLOWUP_PROPERTY, followupMarker, hasCapaLink, isRecoveryTask, recoveryConfirmation, recoveryJql, recoveryMarkerKind, repairLinkConfirmation } from '../lib/followup';

const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
async function getIssue(id) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${id}?fields=summary,project,status,assignee,created&properties=qualityloop`, { headers });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return response.json();
}
async function getFollowupTask(id) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${id}?fields=summary,project,status,assignee,created,issuelinks&properties=qualityloop-followup&failFast=true`, { headers });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return response.json();
}
async function setFollowupMarker(taskId, decisionId, decision) {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${taskId}/properties/qualityloop-followup`, {
    method: 'PUT', headers, body: JSON.stringify(followupMarker(decisionId, decision)),
  });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return true;
}
async function getRelatesType() {
  const response = await api.asUser().requestJira(route`/rest/api/3/issueLinkType`, { headers });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return (await response.json()).issueLinkTypes?.find((type) => type.name?.toLowerCase() === 'relates');
}
const linkTask = (task, capa, type) => api.asUser().requestJira(route`/rest/api/3/issueLink`, {
  method: 'POST', headers, body: JSON.stringify({ type: { id: type.id },
    outwardIssue: { id: task.id }, inwardIssue: { id: capa.id } }),
});
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

  async function loadDecisionView(issueId, matches, budget, authorised, undisplayed) {
    const pairs = {};
    let incomplete = false;
    try {
      // Cache promises before awaiting: concurrent CAPAs share in-flight reads,
      // including denials. These caches last for this invocation only.
      const readIssue = (id) => {
        if (!authorised.has(id)) authorised.set(id, budget.run(() => getIssue(id)));
        return authorised.get(id);
      };
      const states = new Map();
      const readPair = (capaId, ncId) => {
        const key = pairKey(capaId, ncId);
        if (!states.has(key)) states.set(key, budget.run(() => getPairState(capaId, ncId, budget)));
        return states.get(key);
      };
      if (!await readIssue(issueId)) return null;
      const loadPairStates = async (capaIds) => {
        for (let offset = 0; offset < capaIds.length; offset += 5) {
          budget.check();
          const batch = await Promise.allSettled(capaIds.slice(offset, offset + 5).map(async (capaId) => {
            const capa = await readIssue(capaId);
            if (!capa) return;
            const pairState = await readPair(capaId, issueId);
            pairs[capaId] = { pairState, pairStateIncomplete: false, history: [], historyIncomplete: true,
              confirmedCount: null, confirmedCountUnavailable: true, confirmedCountIncomplete: true,
              concernAllowed: concernAllowed(pairState, capa.properties?.qualityloop), capaKey: capa.key, capaSummary: capa.fields?.summary };
          }));
          const failure = batch.find((item) => item.status === 'rejected');
          if (failure) throw failure.reason;
        }
      };
      // Publish state/version for every displayed card before optional index,
      // history, author-name and aggregate-count work can exhaust the budget.
      const ids = new Set([...(matches.strong ?? []), ...(matches.relatedRevision ?? [])].map(({ id }) => id));
      await loadPairStates([...ids]);
      const indexed = await queryRecords(PAIR_ENTITY, 'by-issue', issueId, { budget });
      incomplete = indexed.incomplete;
      const historicalIds = new Set();
      for (const pair of indexed.records) if (pair.issueId === issueId && validIssueId(pair.capaId) &&
          !ids.has(pair.capaId) && !undisplayed.has(pair.capaId)) historicalIds.add(pair.capaId);
      await loadPairStates([...historicalIds]);
      const names = new Map();
      const capaIds = Object.keys(pairs);
      for (let offset = 0; offset < capaIds.length; offset += 5) {
        budget.check();
        // Wait for the whole bounded batch, including on a timeout, so no work
        // can publish late results after this invocation has returned.
        const batch = await Promise.allSettled(capaIds.slice(offset, offset + 5).map(async (capaId) => {
          const data = pairs[capaId];
          const { pairState } = data;
          const page = await queryRecords(DECISION_ENTITY, 'by-issue', issueId, { capaId, limit: 51, budget });
          let history = page.records.filter((record) => record.capaId === capaId && record.issueId === issueId);
          if (pairState.latestDecisionId && !history.some(({ id }) => id === pairState.latestDecisionId)) {
            const latest = await budget.run(() => readDecision(pairState.latestDecisionId));
            if (latest?.issueId === issueId && latest.capaId === capaId) history.push({ ...latest, id: pairState.latestDecisionId });
          }
          const knownHistory = !page.incomplete ? { records: [...history], incomplete: false } : undefined;
          const historyIncomplete = page.incomplete || history.length > 50;
          history = history.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 50);
          const publicHistory = [];
          for (const record of history) {
            if (!names.has(record.authorAccountId)) names.set(record.authorAccountId, budget.run(() => displayName(record.authorAccountId)));
            const authorDisplayName = await names.get(record.authorAccountId);
            let taskKey;
            if (record.taskKey && await readIssue(record.taskKey)) taskKey = record.taskKey;
            publicHistory.push({ id: record.id, type: record.type, reason: record.reason,
              reasonCategory: record.reasonCategory, evidenceLinks: record.evidenceLinks,
              createdAt: record.createdAt, authorDisplayName, ...(taskKey ? { taskKey, taskLinked: !!record.taskLinkedAt } : {}),
              ...(record.taskClaimId && !record.taskKey ? { followupUnconfirmed: true } : {}) });
          }
          budget.check();
          data.history = publicHistory;
          data.historyIncomplete = historyIncomplete;
          const countPage = await queryRecords(PAIR_ENTITY, 'by-capa', capaId, { limit: 51, budget });
          let confirmedCount = 0;
          let confirmedCountIncomplete = countPage.incomplete;
          const seen = new Set();
          for (const record of countPage.records) {
            if (record.capaId !== capaId || !validIssueId(record.issueId) || seen.has(record.issueId)) continue;
            seen.add(record.issueId);
            if (!await readIssue(record.issueId)) continue;
            // Indexes discover pairs; direct state reads decide their current status.
            const state = await readPair(capaId, record.issueId);
            try { if (await pairConfirmed(state, capaId, record.issueId, budget, record.issueId === issueId ? knownHistory : undefined)) confirmedCount += 1; }
            catch (error) {
              if (error instanceof BudgetExceeded) throw error;
              confirmedCountIncomplete = true;
            }
          }
          budget.check();
          data.confirmedCount = confirmedCount > 50 ? '50+' : confirmedCount;
          data.confirmedCountIncomplete = confirmedCountIncomplete;
          data.confirmedCountUnavailable = false;
        }));
        const failure = batch.find((item) => item.status === 'rejected');
        if (failure) throw failure.reason;
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
    const undisplayed = new Set();
    const matches = await findMatches(issueId, budget, authorised, undisplayed);
    if (!matches || matches.error) return matches;
    const decisions = await loadDecisionView(issueId, matches, budget, authorised, undisplayed);
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
  async function taskContext(issueId, payload, context, mode = 'create') {
    if (!validIssueId(payload.capaId)) return null;
    const prefix = `${pairKey(payload.capaId, issueId)}:`;
    if (typeof payload.decisionId !== 'string' || !payload.decisionId.startsWith(prefix) || payload.decisionId.length > 160) return null;
    const capa = await getIssue(payload.capaId);
    if (!capa || !await getIssue(issueId)) return null;
    if (!await canEdit(issueId)) return deniedEdit();
    const decision = await readDecision(payload.decisionId);
    if (!decision || decision.type !== 'CONCERN' || decision.capaId !== payload.capaId ||
        decision.issueId !== issueId || (mode === 'create' && decision.authorAccountId !== context?.accountId)) return null;
    const project = capa.fields?.project;
    if (!project?.id || !project.key) return { error: 'Recorded. The CAPA project could not be read.' };
    if (mode === 'repair') {
      if (!decision.taskClaimId || !decision.taskKey) return { message: 'Refresh history; this concern has no recorded follow-up task.' };
      return { capa, decision, project, decisionId: payload.decisionId };
    }
    if (mode === 'recovery') {
      if (!decision.taskClaimId || decision.taskKey) return { message: 'Refresh history; this concern no longer has an unconfirmed follow-up.' };
      if (!Number.isFinite(Date.parse(decision.taskClaimedAt))) {
        return { message: 'The follow-up claim time was not recorded for this older decision. Check Jira manually; another task will not be created.' };
      }
      return { capa, decision, project, decisionId: payload.decisionId };
    }
    if (decision.taskClaimId || decision.taskKey) return { message: 'Recorded. Follow-up was already attempted; check the history and Jira before creating another task.' };
    if (!await canCreate(project.id)) return { message: noCreateMessage(project.key) };
    return { capa, decision, project, confirmation: followupConfirmation(project.key, capa.key, capa.fields?.assignee) };
  }
  define('prepareConcernTask', ['capaId', 'decisionId'], async (issueId, payload, context) => {
    const result = await taskContext(issueId, payload, context);
    if (!result || result.error || result.message) return result;
    return { confirmation: result.confirmation };
  });

  async function searchRecovery({ capa, decision, project, decisionId }) {
    const budget = loadBudget();
    const found = new Map();
    let token;
    let fetched = 0;
    const seen = new Set();
    for (let pages = 0; pages < 10; pages++) {
      const response = await budget.run(() => api.asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST', headers, body: JSON.stringify({
          jql: recoveryJql(project.id, capa.key, decision.taskClaimedAt), maxResults: Math.min(50, 200 - fetched),
          fields: ['summary', 'project', 'created', 'status'], ...(token ? { nextPageToken: token } : {}),
        }),
      }));
      if ([403, 404].includes(response.status)) return null;
      checkJira(response);
      const page = await budget.run(() => response.json());
      const rows = (page.issues ?? []).slice(0, 200 - fetched);
      fetched += rows.length;
      const selected = rows.filter((row) => {
        const id = String(row.id);
        if (!validIssueId(id) || seen.has(id)) return false;
        seen.add(id);
        return isRecoveryTask(row, project.id, capa.key, decision.taskClaimedAt);
      });
      for (let offset = 0; offset < selected.length; offset += 5) {
        const fresh = await Promise.all(selected.slice(offset, offset + 5).map(async (row) => {
          const task = await budget.run(() => getFollowupTask(String(row.id)));
          return String(task?.id) === String(row.id) ? task : null;
        }));
        for (const task of fresh) if (isRecoveryTask(task, project.id, capa.key, decision.taskClaimedAt)
            && recoveryMarkerKind(task, decisionId, decision)) found.set(String(task.id), task);
      }
      if (found.size > 1) return { message: 'More than one visible matching task was found. Check Jira manually; no task key was recorded and another task will not be created.' };
      const more = page.isLast !== true && (!!page.nextPageToken || page.isLast === false);
      if (!more) {
        const task = [...found.values()][0];
        return task ? { task: { id: String(task.id), key: task.key },
          confirmation: recoveryConfirmation(task.key, capa.key, recoveryMarkerKind(task, decisionId, decision) === 'legacy') }
          : { message: 'No visible matching task was found. Jira indexing may be delayed; check again later or inspect Jira manually. Another task will not be created.' };
      }
      token = page.nextPageToken;
      if (!token || fetched >= 200) break;
    }
    return { message: 'The visible task search is incomplete. Check Jira manually; no task key was recorded and another task will not be created.' };
  }

  define('checkConcernTask', ['capaId', 'decisionId'], async (issueId, payload, context) => {
    const result = await taskContext(issueId, payload, context, 'recovery');
    if (!result || result.error || result.message) return result;
    try { return await searchRecovery(result); }
    catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      return { message: 'The task search timed out. Check again later; another task will not be created.' };
    }
  });

  define('confirmConcernTask', ['capaId', 'decisionId', 'taskId', 'confirmation'], async (issueId, payload, context) => {
    if (!validIssueId(payload.taskId) || !await getIssue(payload.taskId)) return null;
    const result = await taskContext(issueId, payload, context, 'recovery');
    if (!result || result.error || result.message) return result;
    const proposal = await searchRecovery(result);
    if (!proposal || proposal.message) return proposal;
    if (proposal.task.id !== payload.taskId || proposal.confirmation !== payload.confirmation) {
      return { error: 'The proposed recovery changed. Check for task again before confirming.' };
    }
    // Re-check visibility immediately before recording the key. No Jira write.
    const task = await getFollowupTask(payload.taskId);
    if (!task || !await getIssue(payload.capaId) || !await getIssue(issueId)) return null;
    const markerKind = recoveryMarkerKind(task, payload.decisionId, result.decision);
    if (!isRecoveryTask(task, result.project.id, result.capa.key, result.decision.taskClaimedAt) || task.key !== proposal.task.key ||
        !markerKind || recoveryConfirmation(task.key, result.capa.key, markerKind === 'legacy') !== payload.confirmation) {
      return { error: 'The task changed. Check for task again before confirming.' };
    }
    if (!await canEdit(issueId)) return deniedEdit();
    const saved = await saveTaskMetadata(payload.decisionId, { ...result.decision, taskKey: task.key });
    return saved ? { message: `Recorded ${task.key} as the follow-up task.`, taskKey: task.key }
      : { error: 'The follow-up metadata changed. Refresh history before continuing.' };
  });

  async function repairContext(issueId, payload, context) {
    const result = await taskContext(issueId, payload, context, 'repair');
    if (!result || result.error || result.message) return result;
    const task = await getFollowupTask(result.decision.taskKey);
    if (!task) return null;
    if (task.key !== result.decision.taskKey || !validIssueId(String(task.id)) || !Array.isArray(task.fields?.issuelinks)) {
      return { error: 'The recorded task or its links could not be verified. Refresh history before repairing.' };
    }
    const hasMarker = Object.hasOwn(task.properties ?? {}, FOLLOWUP_PROPERTY);
    if (hasMarker && !recoveryMarkerKind(task, payload.decisionId, result.decision)) {
      return { error: 'This task has a different QualityLoop marker. Check Jira manually; no link was written.' };
    }
    const writeMarker = result.decision.taskMarkerVersion === 1 && !hasMarker;
    const confirmation = repairLinkConfirmation(task.key, result.capa.key, { writeMarker, legacy: !hasMarker && !writeMarker });
    return { ...result, task, writeMarker, confirmation };
  }
  define('prepareRepairLink', ['capaId', 'decisionId'], async (issueId, payload, context) => {
    const result = await repairContext(issueId, payload, context);
    return result && !result.error && !result.message ? { confirmation: result.confirmation } : result;
  });
  define('repairConcernLink', ['capaId', 'decisionId', 'confirmation'], async (issueId, payload, context) => {
    const result = await repairContext(issueId, payload, context);
    if (!result || result.error || result.message) return result;
    if (payload.confirmation !== result.confirmation) return { error: 'The proposed repair changed. Open Repair link again.' };
    const { task, capa, decision } = result;
    // Resolve the site-specific link ID first, then re-read both issues immediately
    // before the confirmed write. Jira also treats a duplicate link as success.
    const type = await getRelatesType();
    if (!type) return { error: 'The Relates link type is unavailable. Check Jira before repairing.' };
    const fresh = await repairContext(issueId, payload, context);
    if (!fresh || fresh.error || fresh.message) return fresh;
    if (fresh.confirmation !== payload.confirmation || String(fresh.task.id) !== String(task.id) || String(fresh.capa.id) !== String(capa.id)) {
      return { error: 'The proposed repair changed. Open Repair link again.' };
    }
    if (fresh.writeMarker && !await setFollowupMarker(task.id, payload.decisionId, fresh.decision)) return null;
    if (!hasCapaLink(fresh.task, fresh.capa)) {
      const linked = await linkTask(fresh.task, fresh.capa, type);
      if (!linked.ok) return { error: 'Link repair could not finish. Check Jira and try Repair link again.' };
    }
    if (!await saveTaskLinked(payload.decisionId, decision)) return { error: 'The follow-up metadata changed. Refresh history before continuing.' };
    return { message: 'The follow-up link is verified and recorded.' };
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
      const linkType = await getRelatesType();
      if (!linkType) return { error: 'Recorded. The relates to link type is unavailable. Ask the CAPA owner to review.' };
      // Re-authorise after metadata reads, before claiming and writing.
      const freshCapa = await getIssue(payload.capaId);
      if (!freshCapa || !await getIssue(issueId)) return null;
      if (freshCapa.fields?.project?.id !== project.id || freshCapa.key !== capa.key) {
        return { error: 'Recorded. The CAPA project or key changed. Open a new follow-up confirmation.' };
      }
      // Keep the identity recheck even when two assignees share a display name.
      if (freshCapa.fields?.assignee?.accountId !== capa.fields?.assignee?.accountId ||
          followupConfirmation(project.key, capa.key, freshCapa.fields?.assignee) !== confirmation) {
        return { error: 'Recorded. The intended assignee changed. Open a new follow-up confirmation.' };
      }
      if (!await canEdit(issueId)) return deniedEdit();
      if (!await canCreate(project.id)) return { message: noCreateMessage(project.key) };
      claimed = await claimTask(payload.decisionId, decision);
      if (!claimed) return { message: 'Recorded. Follow-up was already attempted; check Jira before creating another task.' };
      const intendedAssignee = freshCapa.fields?.assignee;
      const fields = { project: { id: project.id }, issuetype: { id: taskType.id }, summary: `Effectiveness re-review: ${capa.key}`,
        assignee: intendedAssignee?.accountId ? { accountId: intendedAssignee.accountId } : null };
      const create = () => api.asUser().requestJira(route`/rest/api/3/issue`, {
        method: 'POST', headers, body: JSON.stringify({ fields }),
      });
      let response = await create();
      // Retry only a definitive validation rejection of assignee. Never retry
      // an ambiguous response, transport error, 429, 5xx, or a general denial.
      if (response.status === 400 && intendedAssignee?.accountId) {
        const rejected = await response.json();
        if (rejected.errors?.assignee) { fields.assignee = null; response = await create(); }
      }
      if ([403, 404].includes(response.status)) return null;
      if (!response.ok) return { error: `Recorded. Task creation returned HTTP ${response.status}. Check Jira before trying another follow-up.` };
      const task = await response.json();
      taskKey = task.key;
      if (await saveTaskMetadata(payload.decisionId, { ...claimed, taskKey }) === false) {
        return { error: 'Recorded. Follow-up metadata changed. Check the decision history before continuing.' };
      }
      // The server-generated task ID is still checked asUser before linking.
      const createdTask = await getIssue(task.id);
      if (!createdTask || !await getIssue(payload.capaId)) return null;
      if (!await setFollowupMarker(task.id, payload.decisionId, claimed)) return null;
      const linked = await linkTask(task, capa, linkType);
      if (!linked.ok) return { error: 'Recorded. Follow-up linking could not finish. Check Jira before creating another task.' };
      if (!await saveTaskLinked(payload.decisionId, { ...claimed, taskKey })) {
        return { error: 'Recorded. Link completion could not be recorded. Refresh history and use Repair link.' };
      }
      const assignee = createdTask.fields?.assignee;
      const ownership = assignee?.accountId ? `assigned to ${assignee.displayName?.trim() || "the CAPA's current assignee"}` : 'unassigned';
      return { message: `Recorded. Created ${taskKey} and linked it to ${capa.key}; ${ownership}.` };
    } catch {
      console.error('QualityLoop concern follow-up failed.');
      return { error: 'Recorded. Follow-up could not finish. Check Jira before creating another task.' };
    }
  });
}
