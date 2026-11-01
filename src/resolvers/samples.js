import { randomUUID } from 'node:crypto';
import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { removableSample, SAMPLE_LABEL, sampleCreationLines, sampleDefinitions, selectSampleIssueType } from '../lib/sampleScenario';
import { RECORD_ENTITIES, recordsForIssues } from '../lib/cleanup';
import { deleteRecordBatch, recordPage } from './cleanupStore';
import { pageDefine, projectContext, readTicket, saveTicket, userJira, validCursor } from './pageUtils';

const resolver = new Resolver();
const sampleKey = (project) => `sample:${project.id}`;
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

async function sampleIssue(id) {
  const response = await userJira(route`/rest/api/3/issue/${id}?fields=labels,project`);
  if ([403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error(`Sample read returned HTTP ${response.status}`);
  return response.json();
}

// A per-project, atomic lock serializes browser tabs. An ambiguous issue creation
// is marked before calling Jira, so even after a timeout it is never auto-retried.
async function mutateSample(project, fn) {
  const key = `sample-lock:${project.id}`;
  try {
    await kvs.set(key, { owner: randomUUID() }, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'MINUTES', value: 1 } });
  } catch { return { error: 'A sample operation is already running. Wait for it to finish, then refresh.' }; }
  try { return await fn(); }
  finally { await kvs.delete(key); }
}

pageDefine(resolver, 'sampleStatus', [], async (context) => {
  const project = await projectContext(context);
  if (!project) return null;
  const sample = await kvs.get(sampleKey(project));
  if (!sample) return { exists: false };
  const visible = [];
  for (const item of sample.items) {
    const issue = await sampleIssue(item.id);
    if (removableSample(sample.items.map(({ id }) => id), issue)) visible.push({ key: issue.key });
  }
  return { exists: true, status: sample.status, issues: visible,
    notes: sample.notes.filter((note) => visible.some(({ key }) => note.startsWith(`${key}:`))) };
});

pageDefine(resolver, 'prepareSample', [], async (context) => {
  const project = await projectContext(context);
  if (!project) return null;
  if (await kvs.get(sampleKey(project))) return { error: 'A sample scenario already exists. Remove it before creating another.' };
  // Creation metadata is available to creators in both project management styles.
  // Keep the first standard type, but prefer Task even when it is on a later page.
  let startAt = 0;
  let type;
  do {
    const response = await userJira(route`/rest/api/3/issue/createmeta/${project.id}/issuetypes?startAt=${startAt}&maxResults=200`);
    if ([403, 404].includes(response.status)) return null;
    if (!response.ok) return { error: 'Jira issue creation metadata could not be read. Check your Create Issues permission. No sample issues were created.' };
    const page = await response.json();
    const issueTypes = page.issueTypes ?? [];
    type = selectSampleIssueType([...(type ? [type] : []), ...issueTypes]);
    startAt += issueTypes.length;
    if (type?.name === 'Task' || !issueTypes.length || startAt >= page.total) break;
  } while (true);
  if (!type) return { error: 'No non-subtask issue type is available for you to create in this project. No sample issues were created.' };
  const links = await userJira(route`/rest/api/3/issueLinkType`);
  if (!links.ok) return { error: 'Jira link types could not be read. No sample issues were created.' };
  const link = (await links.json()).issueLinkTypes?.find((item) =>
    item.inward?.toLowerCase() === 'relates to' && item.outward?.toLowerCase() === 'relates to');
  if (!link) return { error: 'Enable the relates to issue link type before creating the sample.' };
  const definitions = sampleDefinitions();
  const plan = { projectId: project.id, issueTypeId: type.id, linkTypeId: link.id, definitions };
  return { token: await saveTicket('sample-plan', context, plan),
    lines: [`Create exactly five issues in ${project.key}, using issue type ${type.name}, each labelled ${SAMPLE_LABEL}.`,
      'All sample part numbers, suppliers and lines use the DEMO- prefix to keep matches separate from non-DEMO data.',
      ...sampleCreationLines(definitions),
      'Link DEMO historical NC to DEMO CAPA-A using relates to.',
      'For each of the three sample CAPAs, attempt an available transition to a Done-category status. Leave its Jira status unchanged if no transition is available or Jira refuses it. Do not change workflows.',
      'Save the created issue IDs and your account ID in Forge hosted storage. The CAPA-A evidence URL is illustrative sample data.'] };
});

pageDefine(resolver, 'startSample', ['token', 'confirmed'], async (context, { token, confirmed }) => {
  const project = await projectContext(context);
  if (!project) return null;
  const plan = await readTicket('sample-plan', token, context);
  if (!plan || plan.projectId !== project.id || confirmed !== true) return { error: 'Open and confirm a new sample creation dialog.' };
  const sample = { scenarioId: randomUUID(), creatorAccountId: context.accountId, items: [], status: 'creating',
    definitions: plan.definitions, issueTypeId: plan.issueTypeId, linkTypeId: plan.linkTypeId, notes: [] };
  // Reservation is atomic: two confirmed dialogs cannot both create a scenario.
  try { await kvs.set(sampleKey(project), sample, { keyPolicy: 'FAIL_IF_EXISTS' }); }
  catch { return { error: 'A sample already exists or storage is unavailable. Refresh before continuing.' }; }
  await kvs.delete(`sample-plan:${token}`);
  return { started: true };
});

pageDefine(resolver, 'advanceSample', [], async (context) => {
  const project = await projectContext(context);
  if (!project) return null;
  return mutateSample(project, async () => {
    const key = sampleKey(project);
    const sample = await kvs.get(key);
    if (!sample || sample.creatorAccountId !== context.accountId || sample.status !== 'creating') return { error: 'No sample creation is pending for your account.' };
    if (sample.attempting !== undefined) return { error: 'A Jira create response was interrupted. Check issues labelled qualityloop-sample before removing this partial scenario; creation will not be repeated automatically.' };
    if (sample.items.length < 5) {
      const index = sample.items.length;
      const definition = sample.definitions[index];
      await kvs.set(key, { ...sample, attempting: index });
      const response = await userJira(route`/rest/api/3/issue`, post({ fields: {
        project: { id: project.id }, issuetype: { id: sample.issueTypeId }, summary: definition.name, labels: [SAMPLE_LABEL],
      }, properties: [{ key: 'qualityloop', value: definition.capture }] }));
      if (!response.ok) {
        // Even an error is not retried automatically; required custom fields may
        // prevent creation. The partial reservation is available for removal.
        return { error: `Sample creation returned HTTP ${response.status}. Remove the partial scenario before trying again. Check Jira for any interrupted create.` };
      }
      const issue = await response.json();
      if (!/^\d+$/.test(issue.id) || typeof issue.key !== 'string') throw new Error('Invalid Jira create response.');
      sample.items.push({ id: issue.id, key: issue.key });
      await kvs.set(key, sample);
      return { done: false };
    }
    const transitionIndex = sample.transitionIndex ?? 0;
    if (transitionIndex < 3) {
      const item = sample.items[transitionIndex];
      const issue = await sampleIssue(item.id);
      if (!removableSample(sample.items.map(({ id }) => id), issue) || issue.fields?.project?.id !== project.id) {
        sample.notes.push(`${item.key}: no transition attempted because sample access or its label changed.`);
      } else {
        const response = await userJira(route`/rest/api/3/issue/${item.id}/transitions`);
        if (!response.ok) sample.notes.push(`${issue.key}: Jira transitions could not be read; status left unchanged.`);
        else {
          const done = (await response.json()).transitions?.filter((transition) => transition.to?.statusCategory?.key === 'done');
          let transitioned = false;
          for (const transition of done ?? []) {
            const moved = await userJira(route`/rest/api/3/issue/${item.id}/transitions`, post({ transition: { id: transition.id } }));
            if (moved.ok) { transitioned = true; break; }
          }
          if (!transitioned) sample.notes.push(`${issue.key}: no available Done-category transition succeeded; Jira status left unchanged. QualityLoop closure date remains recorded.`);
        }
      }
      sample.transitionIndex = transitionIndex + 1;
      await kvs.set(key, sample);
      return { done: false };
    }
    const historical = await sampleIssue(sample.items[3].id);
    const capa = await sampleIssue(sample.items[0].id);
    if (!historical || !capa) return null;
    if (![historical, capa].every((issue) => removableSample(sample.items.map(({ id }) => id), issue) && issue.fields?.project?.id === project.id)) {
      return { error: 'Sample labels or project changed before linking. Remove the partial scenario and try again.' };
    }
    const linked = await userJira(route`/rest/api/3/issueLink`, post({ type: { id: sample.linkTypeId },
      outwardIssue: { id: historical.id }, inwardIssue: { id: capa.id } }));
    if (!linked.ok) return { error: `Sample issues were created, but linking returned HTTP ${linked.status}. Remove the partial scenario and try again.` };
    sample.status = 'complete';
    await kvs.set(key, sample);
    return { done: true };
  });
});

pageDefine(resolver, 'sampleReadiness', [], async (context) => {
  const project = await projectContext(context);
  if (!project) return null;
  const sample = await kvs.get(sampleKey(project));
  if (!sample || sample.status !== 'complete') return { ready: false };
  const ids = sample.items.slice(0, 3).map(({ id }) => id);
  const response = await userJira(route`/rest/api/3/search/jql`, post({
    jql: `project = ${project.id} AND id in (${ids.join(',')}) AND labels = "${SAMPLE_LABEL}" AND qlRecordType = "CAPA" AND qlClosed IS NOT EMPTY AND qlPart IS NOT EMPTY AND qlFailureMode IS NOT EMPTY`,
    maxResults: 3, fields: ['id'],
  }));
  if ([403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error(`Sample search returned HTTP ${response.status}`);
  const found = new Set((await response.json()).issues?.map(({ id }) => String(id)));
  if (!ids.every((id) => found.has(id))) return { ready: false };
  const nc = await sampleIssue(sample.items[4].id);
  if (!removableSample(sample.items.map(({ id }) => id), nc)) return null;
  // Notes only describe currently visible labelled samples.
  const visibleKeys = [];
  for (const item of sample.items.slice(0, 3)) {
    const issue = await sampleIssue(item.id);
    if (!removableSample(ids, issue)) return null;
    visibleKeys.push(issue.key);
  }
  return { ready: true, newNcKey: nc.key, notes: sample.notes.filter((note) => visibleKeys.some((key) => note.startsWith(`${key}:`))) };
});

pageDefine(resolver, 'prepareSampleRemoval', [], async (context) => {
  const project = await projectContext(context);
  if (!project) return null;
  const sample = await kvs.get(sampleKey(project));
  if (!sample) return { error: 'No stored sample scenario exists.' };
  const issues = [];
  let inaccessible = false;
  for (const item of sample.items) {
    const issue = await sampleIssue(item.id);
    if (!issue) { inaccessible = true; continue; }
    if (removableSample(sample.items.map(({ id }) => id), issue)) issues.push({ id: issue.id, key: issue.key });
  }
  const ticket = { projectId: project.id, scenarioId: sample.scenarioId, issues,
    baselineIds: sample.items.map(({ id }) => id), deletedIds: [], reports: [], inaccessible };
  return { token: await saveTicket('sample-removal', context, ticket), keys: issues.map(({ key }) => key),
    note: 'Delete only these stored issues while they still carry qualityloop-sample, plus their decision and pair-state records. Clear the sample registration afterwards. Issues without the label are left in Jira.',
    warning: sample.attempting !== undefined ? 'An interrupted create may have made an unregistered issue. Check Jira for qualityloop-sample issues; this operation cannot delete an ID it did not store.' : undefined };
});

pageDefine(resolver, 'startSampleRemoval', ['token', 'confirmed'], async (context, { token, confirmed }) => {
  const project = await projectContext(context);
  if (!project) return null;
  return mutateSample(project, async () => {
    const ticket = await readTicket('sample-removal', token, context);
    const sample = await kvs.get(sampleKey(project));
    if (!ticket || !sample || ticket.projectId !== project.id || ticket.scenarioId !== sample.scenarioId || confirmed !== true ||
        JSON.stringify(ticket.baselineIds) !== JSON.stringify(sample.items.map(({ id }) => id))) {
      return { error: 'The sample changed. Open a new removal confirmation.' };
    }
    // Freeze creation between invocations so the confirmed list cannot grow.
    await kvs.set(sampleKey(project), { ...sample, status: 'removing', removalToken: token });
    return { started: true };
  });
});

pageDefine(resolver, 'removeSampleIssue', ['token', 'confirmed', 'index'], async (context, { token, confirmed, index }) => {
  const project = await projectContext(context);
  if (!project) return null;
  return mutateSample(project, async () => {
    const ticket = await readTicket('sample-removal', token, context);
    const sample = await kvs.get(sampleKey(project));
    if (!ticket || !sample || sample.removalToken !== token || ticket.scenarioId !== sample.scenarioId || ticket.projectId !== project.id || confirmed !== true ||
        !Number.isInteger(index) || index < 0 || index >= ticket.issues.length) return { error: 'Open a new removal confirmation.' };
    const item = ticket.issues[index];
    if (ticket.deletedIds.includes(item.id)) return { handled: true };
    const issue = await sampleIssue(item.id);
    if (!issue) ticket.inaccessible = true;
    else if (!removableSample(sample.items.map(({ id }) => id), issue)) ticket.reports.push({ id: item.id, message: 'label removed; left in Jira.' });
    else if (issue.key !== item.key) ticket.reports.push({ id: item.id, message: 'key changed; left in Jira. Open a new confirmation to remove it.' });
    else {
      // No deleteSubtasks: a newly added subtask must never be deleted implicitly.
      const response = await userJira(route`/rest/api/3/issue/${item.id}`, { method: 'DELETE' });
      if (response.ok) ticket.deletedIds.push(item.id);
      else ticket.reports.push({ id: item.id, message: 'could not delete; check Jira before retrying.' });
    }
    await kvs.set(`sample-removal:${token}`, ticket, { ttl: { unit: 'HOURS', value: 1 } });
    return { handled: true };
  });
});

pageDefine(resolver, 'cleanupSamplePage', ['token', 'confirmed', 'entity', 'cursor'], async (context, { token, confirmed, entity, cursor }) => {
  const project = await projectContext(context);
  if (!project) return null;
  const ticket = await readTicket('sample-removal', token, context);
  const sample = await kvs.get(sampleKey(project));
  if (!ticket || !sample || sample.removalToken !== token || ticket.projectId !== project.id || ticket.scenarioId !== sample.scenarioId || confirmed !== true ||
      !RECORD_ENTITIES.includes(entity) || !validCursor(cursor)) return { error: 'Open a new removal confirmation.' };
  // Cursor stays in the active browser, never in durable storage. A by-key scan
  // includes legacy records and is independent of the new attribute indexes.
  const page = await recordPage(entity, cursor);
  const selected = recordsForIssues(page.records, ticket.deletedIds);
  await deleteRecordBatch(selected);
  return { nextCursor: page.nextCursor };
});

pageDefine(resolver, 'finishSampleRemoval', ['token', 'confirmed'], async (context, { token, confirmed }) => {
  const project = await projectContext(context);
  if (!project) return null;
  return mutateSample(project, async () => {
    const ticket = await readTicket('sample-removal', token, context);
    const sample = await kvs.get(sampleKey(project));
    if (!ticket || !sample || sample.removalToken !== token || ticket.projectId !== project.id || ticket.scenarioId !== sample.scenarioId || confirmed !== true) return { error: 'Open a new removal confirmation.' };
    // Reports can outlive Browse permission. Never return saved issue keys.
    const reports = [];
    for (const report of ticket.reports) {
      if (!ticket.issues.some(({ id }) => id === report.id)) continue;
      const issue = await sampleIssue(report.id);
      if (issue) reports.push(`${issue.key}: ${report.message}`);
    }
    await kvs.delete(sampleKey(project));
    await kvs.delete(`sample-removal:${token}`);
    return { reports,
      message: 'Sample registration cleared. Check Jira for any sample issues left behind.' };
  });
});

export const handler = resolver.getDefinitions();
