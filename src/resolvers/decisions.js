import api, { route } from '@forge/api';
import { concernAllowed, followupConfirmation, validIssueId, validateDecision, nextState, pairKey } from '../lib/decisions';
import { claimTask, commitDecision, getPairState, queryRecords, pairConfirmed, PAIR_ENTITY, DECISION_ENTITY, readDecision, saveTaskMetadata, saveTaskLinked } from './decisionStore';
import { matchCaptures } from '../lib/match';
import { issueCapture } from './evidence';
import { selectSampleIssueType } from '../lib/sampleScenario';
import { BudgetExceeded, checkJira, loadBudget } from './loadBudget';
import { FOLLOWUP_PROPERTY, followupMarker, followupDescription, jiraSiteOrigin, descriptionPreview, hasDescription, hasCapaLink, isRecoveryTask, recoveryConfirmation, recoveryJql, recoveryMarkerKind, repairLinkConfirmation } from '../lib/followup';

const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
async function getSiteUrl() {
  // Native resolver context has no documented siteUrl. Issue self may use the API gateway.
  try {
    const response = await api.asUser().requestJira(route`/rest/api/3/serverInfo`, { headers });
    if (!response.ok) return null;
    return jiraSiteOrigin((await response.json()).baseUrl);
  } catch {
    return null; // A missing site URL must not prevent a plain-text NC description.
  }
}
async function getIssue(id) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${id}?fields=summary,project,status,assignee,created&properties=qualityloop`, { headers });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return response.json();
}
async function getFollowupTask(id) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${id}?fields=summary,description,project,status,assignee,created,issuelinks&properties=qualityloop-followup&failFast=true`, { headers });
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
async function getStandardType(projectId) {
  let startAt = 0, selected;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issue/createmeta/${projectId}/issuetypes?startAt=${startAt}&maxResults=200`, { headers });
    if ([403, 404].includes(response.status)) return null;
    checkJira(response);
    const page = await response.json();
    const types = page.issueTypes ?? [];
    selected = selectSampleIssueType([...(selected ? [selected] : []), ...types]);
    startAt += types.length;
    if (selected?.name === 'Task' || !types.length || startAt >= page.total) return { type: selected };
  }
  return { error: 'Issue type metadata is incomplete. No follow-up was created.' };
}
const confirmationFor = ({ project, capa, nc, type, linkType, description }) => followupConfirmation(
  project.key, capa.key, capa.fields?.assignee,
  { ncKey: nc.key, typeName: type.name, description: descriptionPreview(description), linkAvailable: !!linkType },
);
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
              createdAt: record.createdAt, authorDisplayName, ...(taskKey ? { taskKey, taskLinked: !!record.taskLinkedAt && !!record.taskNcLinkedAt && !!record.taskDescriptionAt } : {}),
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
    const nc = await getIssue(issueId);
    if (!capa || !nc) return null;
    if (!await canEdit(issueId)) return deniedEdit();
    const decision = await readDecision(payload.decisionId);
    if (!decision || decision.type !== 'CONCERN' || decision.capaId !== payload.capaId ||
        decision.issueId !== issueId || (mode === 'create' && decision.authorAccountId !== context?.accountId)) return null;
    const project = capa.fields?.project;
    if (!project?.id || !project.key) return { error: 'Recorded. The CAPA project could not be read.' };
    if (mode === 'repair') {
      if (!decision.taskClaimId || !decision.taskKey) return { message: 'Refresh history; this concern has no recorded follow-up task.' };
      return { capa, nc, decision, project, siteUrl: await getSiteUrl(), decisionId: payload.decisionId };
    }
    if (mode === 'recovery') {
      if (!decision.taskClaimId || decision.taskKey) return { message: 'Refresh history; this concern no longer has an unconfirmed follow-up.' };
      if (!Number.isFinite(Date.parse(decision.taskClaimedAt))) {
        return { message: 'The follow-up claim time was not recorded for this older decision. Check Jira manually; another task will not be created.' };
      }
      return { capa, nc, decision, project, decisionId: payload.decisionId };
    }
    if (decision.taskClaimId || decision.taskKey) return { message: 'Recorded. Follow-up was already attempted; check the history and Jira before creating another task.' };
    if (!await canCreate(project.id)) return { message: noCreateMessage(project.key) };
    const metadata = await getStandardType(project.id);
    if (!metadata || metadata.error) return metadata;
    if (!metadata.type) return { error: 'No non-subtask issue type is available. No follow-up was created.' };
    const siteUrl = await getSiteUrl();
    const plan = { capa, nc, decision, project, siteUrl, type: metadata.type, linkType: await getRelatesType(),
      description: followupDescription(decision, nc, capa, siteUrl), decisionId: payload.decisionId };
    return { ...plan, confirmation: confirmationFor(plan) };
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
    const writeMarker = [1, 2].includes(result.decision.taskMarkerVersion) && !hasMarker;
    const description = followupDescription(result.decision, result.nc, result.capa, result.siteUrl);
    const linkType = await getRelatesType();
    const confirmation = repairLinkConfirmation(task.key, result.capa.key, { ncKey: result.nc.key,
      description: descriptionPreview(description), linkAvailable: !!linkType, writeMarker, legacy: !hasMarker && !writeMarker });
    return { ...result, task, description, linkType, writeMarker, confirmation };
  }

  // Re-read all three issues asUser immediately before EACH Jira write. Never
  // reuse an authorization snapshot from the proposal or an earlier link write.
  async function freshFollowup(plan) {
    const [task, capa, nc] = await Promise.all([getFollowupTask(plan.task.key), getIssue(plan.decision.capaId), getIssue(plan.decision.issueId)]);
    if (!task || !capa || !nc) return null;
    if (!await canEdit(plan.decision.issueId)) return deniedEdit();
    if (task.key !== plan.task.key || capa.key !== plan.capa.key || nc.key !== plan.nc.key ||
        String(task.id) !== String(plan.task.id) || !Array.isArray(task.fields?.issuelinks)) {
      return { error: 'The follow-up references or links changed. Refresh history before continuing.' };
    }
    if (Object.hasOwn(task.properties ?? {}, FOLLOWUP_PROPERTY) && !recoveryMarkerKind(task, plan.decisionId, plan.decision)) {
      return { error: 'The task marker could not be verified. Check Jira before continuing.' };
    }
    return { task, capa, nc };
  }

  async function completeFollowup(plan, repair = false) {
    const limits = [];
    const partial = (reason) => ({ message: `Recorded. ${repair ? `Follow-up ${plan.task.key} remains` : `Created ${plan.task.key}`} with limits: ${reason}. Use Verify link to finish the description and both links.`, taskKey: plan.task.key });
    let fresh = await freshFollowup(plan);
    if (!fresh || fresh.error) return fresh;
    if (plan.writeMarker) {
      if (!await canEdit(plan.decision.issueId)) return deniedEdit();
      if (!await setFollowupMarker(fresh.task.id, plan.decisionId, plan.decision)) return partial('the marker could not be written');
      fresh = await freshFollowup(plan);
      if (!fresh || fresh.error) return fresh;
      if (!recoveryMarkerKind(fresh.task, plan.decisionId, plan.decision)) return partial('the marker could not be verified');
    }
    if (repair && !hasDescription(fresh.task)) {
      if (descriptionPreview(followupDescription(plan.decision, fresh.nc, fresh.capa, plan.siteUrl)) !== descriptionPreview(plan.description)) {
        return { error: 'The proposed description changed. Open Verify link again.' };
      }
      try {
        const response = await api.asUser().requestJira(route`/rest/api/3/issue/${fresh.task.id}`, {
          method: 'PUT', headers, body: JSON.stringify({ fields: { description: plan.description } }),
        });
        if (!response.ok) limits.push('the description could not be written');
      } catch { limits.push('the description write could not be confirmed'); }
      fresh = await freshFollowup(plan);
      if (!fresh || fresh.error) return fresh;
    }
    if (hasDescription(fresh.task)) {
      if (!await saveTaskLinked(plan.decisionId, plan.decision, 'description')) limits.push('description completion could not be recorded');
    } else limits.push('the description is missing');
    for (const target of ['capa', 'nc']) {
      fresh = await freshFollowup(plan);
      if (!fresh || fresh.error) return fresh;
      if (!hasCapaLink(fresh.task, fresh[target])) {
        if (!plan.linkType) { limits.push(`the ${target.toUpperCase()} link is missing because Relates is unavailable`); continue; }
        try {
          const linked = await linkTask(fresh.task, fresh[target], plan.linkType);
          if (!linked.ok) { limits.push(`the ${target.toUpperCase()} link could not be written`); continue; }
        } catch { limits.push(`the ${target.toUpperCase()} link write could not be confirmed`); continue; }
      }
      if (!await saveTaskLinked(plan.decisionId, plan.decision, target)) limits.push(`${target.toUpperCase()} link completion could not be recorded`);
    }
    return limits.length ? partial(limits.join('; ')) : { complete: true, task: fresh.task };
  }
  define('prepareRepairLink', ['capaId', 'decisionId'], async (issueId, payload, context) => {
    const result = await repairContext(issueId, payload, context);
    return result && !result.error && !result.message ? { confirmation: result.confirmation } : result;
  });
  define('repairConcernLink', ['capaId', 'decisionId', 'confirmation'], async (issueId, payload, context) => {
    const result = await repairContext(issueId, payload, context);
    if (!result || result.error || result.message) return result;
    if (payload.confirmation !== result.confirmation) return { error: 'The proposed verification changed. Open Verify link again.' };
    const fresh = await repairContext(issueId, payload, context);
    if (!fresh || fresh.error || fresh.message) return fresh;
    if (fresh.confirmation !== payload.confirmation || String(fresh.task.id) !== String(result.task.id) || String(fresh.capa.id) !== String(result.capa.id)) {
      return { error: 'The proposed verification changed. Open Verify link again.' };
    }
    const completed = await completeFollowup(fresh, true);
    return completed?.complete ? { message: 'The follow-up description and both links are verified and recorded.' } : completed;
  });

  define('createConcernTask', ['capaId', 'decisionId', 'confirmation'], async (issueId, payload, context) => {
    const result = await taskContext(issueId, payload, context);
    if (!result || result.error || result.message) return result;
    const { capa, decision, project, confirmation, type: taskType, description } = result;
    if (payload.confirmation !== confirmation) return { error: 'Recorded. The proposed write changed. Open the confirmation again.' };
    let claimed;
    let taskKey;
    try {
      // Re-authorise after metadata reads, before claiming and writing.
      const freshCapa = await getIssue(payload.capaId);
      const freshNc = await getIssue(issueId);
      if (!freshCapa || !freshNc) return null;
      if (freshCapa.fields?.project?.id !== project.id || freshCapa.key !== capa.key) {
        return { error: 'Recorded. The CAPA project or key changed. Open a new follow-up confirmation.' };
      }
      // Keep the identity recheck even when two assignees share a display name.
      if (freshCapa.fields?.assignee?.accountId !== capa.fields?.assignee?.accountId ||
          confirmationFor({ ...result, capa: freshCapa }) !== confirmation) {
        return { error: 'Recorded. The intended assignee changed. Open a new follow-up confirmation.' };
      }
      if (confirmationFor({ ...result, nc: freshNc, description: followupDescription(decision, freshNc, freshCapa, result.siteUrl) }) !== confirmation) {
        return { error: 'Recorded. The proposed description changed. Open a new follow-up confirmation.' };
      }
      if (!await canEdit(issueId)) return deniedEdit();
      if (!await canCreate(project.id)) return { message: noCreateMessage(project.key) };
      claimed = await claimTask(payload.decisionId, decision);
      if (!claimed) return { message: 'Recorded. Follow-up was already attempted; check Jira before creating another task.' };
      const intendedAssignee = freshCapa.fields?.assignee;
      const fields = { project: { id: project.id }, issuetype: { id: taskType.id }, summary: `Effectiveness re-review: ${capa.key}`,
        description, assignee: intendedAssignee?.accountId ? { accountId: intendedAssignee.accountId } : null };
      const properties = [{ key: FOLLOWUP_PROPERTY, value: followupMarker(payload.decisionId, claimed) }];
      const create = async () => {
        const currentCapa = await getIssue(payload.capaId), nc = await getIssue(issueId);
        if (!currentCapa || !nc) return null;
        if (currentCapa.fields?.assignee?.accountId !== freshCapa.fields?.assignee?.accountId ||
            confirmationFor({ ...result, capa: currentCapa, nc, description: followupDescription(decision, nc, currentCapa, result.siteUrl) }) !== confirmation) {
          throw new Error('Follow-up proposal changed.');
        }
        return api.asUser().requestJira(route`/rest/api/3/issue`, {
          method: 'POST', headers, body: JSON.stringify({ fields, properties }),
        });
      };
      let response;
      // Retry only definitive assignee/description validation rejections. Never retry
      // an ambiguous response, transport error, 429, 5xx, or a general denial.
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await create();
        if (!response) return null;
        if (response.status !== 400) break;
        const rejected = await response.json();
        const keys = Object.keys(rejected.errors ?? {});
        if (!keys.length || rejected.errorMessages?.length || keys.some((key) => !['assignee', 'description'].includes(key))) break;
        let changed = false;
        if (rejected.errors.assignee && fields.assignee) { fields.assignee = null; changed = true; }
        if (rejected.errors.description && fields.description) { delete fields.description; changed = true; }
        if (!changed) break;
      }
      if ([403, 404].includes(response.status)) return null;
      if (!response.ok) return { error: `Recorded. Task creation returned HTTP ${response.status}. Check Jira before trying another follow-up.` };
      const task = await response.json();
      taskKey = task.key;
      if (await saveTaskMetadata(payload.decisionId, { ...claimed, taskKey }) === false) {
        return { error: 'Recorded. Follow-up metadata changed. Check the decision history before continuing.' };
      }
      // Record the created key before any optional description/link work.
      const createdTask = await getFollowupTask(task.id);
      if (!createdTask || !await getIssue(payload.capaId) || !await getIssue(issueId)) return null;
      const hasMarker = Object.hasOwn(createdTask.properties ?? {}, FOLLOWUP_PROPERTY);
      if (hasMarker && !recoveryMarkerKind(createdTask, payload.decisionId, claimed)) {
        return { error: 'Recorded. The new task marker could not be verified. Check Jira before continuing.' };
      }
      const completed = await completeFollowup({ ...result, task: createdTask, decision: { ...claimed, taskKey }, writeMarker: !hasMarker });
      if (!completed?.complete) return completed;
      const assignee = completed.task.fields?.assignee;
      const ownership = assignee?.accountId ? `assigned to ${assignee.displayName?.trim() || "the CAPA's current assignee"}` : 'unassigned';
      return { message: `Recorded. Created ${taskKey} and linked it to ${capa.key} and ${result.nc.key}; ${ownership}.` };
    } catch {
      console.error('QualityLoop concern follow-up failed.');
      return { error: 'Recorded. Follow-up could not finish. Check Jira before creating another task.' };
    }
  });
}
