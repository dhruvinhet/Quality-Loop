import { createHash, randomUUID } from 'node:crypto';
import { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { normalise } from '../lib/normalise';
import { pageDefine, readTicket, requireAdmin, saveTicket, userJira, validCursor } from './pageUtils';
import { readSearchSettings } from './searchSettings';
import { checkJira } from './loadBudget';

const fingerprint = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
const differs = (record, parts) => ['partNorm', 'partBase', 'partRevision'].some((key) => record[key] !== parts[key]);
const linesFor = (items) => items.map(({ key, parts }) =>
  `Update ${key}'s qualityloop property: partNorm = ${JSON.stringify(parts.partNorm)}, partBase = ${JSON.stringify(parts.partBase)}, partRevision = ${JSON.stringify(parts.partRevision)}. Keep all other quality details.`);
async function readIssue(id) {
  const response = await userJira(route`/rest/api/3/issue/${id}?fields=project&properties=qualityloop`);
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  const issue = await response.json();
  const record = issue.properties?.qualityloop;
  if (String(issue.id) !== id || !/^\d+$/.test(String(issue.fields?.project?.id)) || typeof issue.key !== 'string' ||
      ![1, 2, 3].includes(record?.schemaVersion) || !['NC', 'CAPA'].includes(record.recordType) || typeof record.partOriginal !== 'string') return null;
  return issue;
}

export function registerPartMaintenance(resolver) {
  // One ten-issue page per invocation keeps the confirmation readable and work bounded.
  pageDefine(resolver, 'scanPartIndexes', ['cursor'], async (context, { cursor }) => {
    if (!await requireAdmin(context)) return null;
    if (!validCursor(cursor)) return { error: 'Invalid scan page. Start a new scan.' };
    const response = await userJira(route`/rest/api/3/search/jql`, { method: 'POST', body: JSON.stringify({
      jql: '(qlRecordType = "NC" OR qlRecordType = "CAPA") ORDER BY key ASC', maxResults: 10, fields: ['id'], ...(cursor ? { nextPageToken: cursor } : {}),
    }) });
    if ([403, 404].includes(response.status)) return null;
    checkJira(response);
    const page = await response.json();
    const items = [];
    for (const id of [...new Set((page.issues ?? []).slice(0, 10).map((issue) => String(issue.id)))]) {
      if (!/^\d+$/.test(id)) continue;
      const issue = await readIssue(id);
      if (!issue) continue;
      const projectId = String(issue.fields.project.id);
      const { revisionPreset } = await readSearchSettings(projectId);
      const record = issue.properties.qualityloop;
      const parts = normalise(record.partOriginal, revisionPreset);
      if (differs(record, parts)) items.push({ id, key: issue.key, projectId, revisionPreset, fingerprint: fingerprint(record), parts });
    }
    const lines = linesFor(items);
    return { token: items.length ? await saveTicket('part-index-plan', context, { items }) : null, lines,
      nextCursor: page.isLast === true ? undefined : page.nextPageToken,
      incomplete: page.isLast === false && !page.nextPageToken };
  });

  pageDefine(resolver, 'repairPartIndexes', ['token', 'confirmation'], async (context, { token, confirmation }) => {
    if (!await requireAdmin(context)) return null;
    const plan = await readTicket('part-index-plan', token, context);
    if (!plan || confirmation !== linesFor(plan.items).join('\n')) return { error: 'Scan again and confirm the listed part-index writes.' };
    const lock = `part-index-lock:${token}`;
    const owner = randomUUID();
    try { await kvs.set(lock, { owner }, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'MINUTES', value: 5 } }); }
    catch { return { error: 'These updates are busy. Check the result before retrying.' }; }
    let updated = 0, skipped = 0;
    try {
      for (const item of plan.items) {
        if (!await requireAdmin(context)) return null;
        // Payload/ticket IDs are freshly authorised, and concurrent capture edits,
        // moves or preset changes require a new preview instead of being overwritten.
        const issue = await readIssue(item.id);
        if (!issue) continue;
        const record = issue.properties.qualityloop;
        const projectId = String(issue.fields.project.id);
        const settings = await readSearchSettings(projectId);
        if (projectId !== item.projectId || issue.key !== item.key || settings.revisionPreset !== item.revisionPreset || fingerprint(record) !== item.fingerprint) { skipped++; continue; }
        if ((await kvs.get(lock))?.owner !== owner) return { error: 'The update lock expired. Check the result and scan again.' };
        const response = await userJira(route`/rest/api/3/issue/${item.id}/properties/qualityloop`, {
          method: 'PUT', body: JSON.stringify({ ...record, ...item.parts }),
        });
        if (response.ok) updated++; else if (![403, 404].includes(response.status)) skipped++;
      }
      return { updated, skipped };
    } finally { if ((await kvs.get(lock))?.owner === owner) await kvs.delete(lock); }
  });
}
