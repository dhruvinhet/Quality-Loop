import Resolver from '@forge/resolver';
import { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { visibleRecords, RECORD_ENTITIES } from '../lib/cleanup';
import { backfillPair, recordPage } from './cleanupStore';
import { pageDefine, readTicket, requireAdmin, saveTicket, userJira, validCursor } from './pageUtils';
import { removableSample } from '../lib/sampleScenario';
import { HEALTH_PREFIX, initialHealth, withHealthTicket, scanHealthPage, removeHealthPage } from './dataHealthStore';
import { registerFailureModeAdmin } from './failureModes';

const resolver = new Resolver();
registerFailureModeAdmin(resolver);
// Jira 404 means missing OR unbrowsable. It is never proof of deletion.
const existence = (id) => userJira(route`/rest/api/3/issue/${id}?fields=id`);

pageDefine(resolver, 'startDataHealthCheck', [], async (context) => {
  if (!await requireAdmin(context)) return null;
  return { token: await saveTicket(HEALTH_PREFIX, context, initialHealth()) };
});
pageDefine(resolver, 'checkOrphanPage', ['token'], async (context, { token }) => {
  if (!await requireAdmin(context)) return null;
  return withHealthTicket(context, token, (state) => scanHealthPage(token, state));
});
pageDefine(resolver, 'removeOrphanPage', ['token', 'confirmed', 'expectedCount'], async (context, { token, confirmed, expectedCount }) => {
  if (!await requireAdmin(context)) return null;
  return withHealthTicket(context, token, (state) => {
    if (confirmed !== true || !state.scanComplete || expectedCount !== state.found) {
      return { error: 'Complete the check and confirm the displayed record count before removing records.' };
    }
    return removeHealthPage(token, state);
  });
});

// Re-fetch registered NCs as the viewer before returning checklist links.
pageDefine(resolver, 'sampleNcLinks', ['cursor'], async (context, { cursor }) => {
  if (!await requireAdmin(context)) return null;
  if (!validCursor(cursor)) return { error: 'Refresh sample links to try again.' };
  let query = kvs.query().where('key', WhereConditions.beginsWith('sample:')).limit(10);
  if (cursor) query = query.cursor(cursor);
  const page = await query.getMany();
  const keys = [];
  for (const { key } of page.results) {
    // Queries may lag a removal; the current registration is authoritative.
    const sample = await kvs.get(key);
    const item = sample?.status !== 'removing' ? sample?.items?.[4] : null;
    if (!/^sample:\d+$/.test(key) || !/^\d+$/.test(item?.id ?? '')) continue;
    const response = await userJira(route`/rest/api/3/issue/${item.id}?fields=labels,project&properties=qualityloop`);
    if ([403, 404].includes(response.status)) continue;
    if (!response.ok) throw new Error(`Sample NC read returned HTTP ${response.status}`);
    const issue = await response.json();
    if (String(issue.id) === String(item.id) && removableSample([String(item.id)], issue) &&
        String(issue.fields?.project?.id) === key.slice('sample:'.length) && issue.properties?.qualityloop?.recordType === 'NC') {
      keys.push(issue.key);
    }
  }
  return { keys: [...new Set(keys)], nextCursor: page.nextCursor };
});

pageDefine(resolver, 'startOrphanScan', [], async (context) => {
  if (!await requireAdmin(context)) return null;
  return { token: await saveTicket('orphan-scan', context, {}) };
});

pageDefine(resolver, 'findOrphanPage', ['token', 'entity', 'cursor'], async (context, { token, entity, cursor }) => {
  if (!await requireAdmin(context)) return null;
  if (!await readTicket('orphan-scan', token, context)) return { error: 'The scan expired. Scan accessible app records again.' };
  if (!RECORD_ENTITIES.includes(entity) || !validCursor(cursor)) return { error: 'Invalid scan page.' };
  const page = await recordPage(entity, cursor);
  const visible = await visibleRecords(page.records, existence);
  let backfilled = 0;
  let backfillPending = 0;
  for (const record of visible) {
    try { if (await backfillPair(record)) backfilled += 1; }
    catch {
      backfillPending += 1;
      console.error('QualityLoop pair-state backfill deferred.');
    }
  }
  return { entity, scanned: visible.length, nextCursor: page.nextCursor, backfilled, backfillPending };
});

// Old clients and pre-release review tickets cannot delete on an ambiguous 404.
pageDefine(resolver, 'deleteOrphanPage', ['token', 'confirmed'], async (context) => {
  if (!await requireAdmin(context)) return null;
  return { error: 'Orphan deletion is unavailable: Jira cannot distinguish a missing issue from one you cannot browse. No records were deleted.' };
});

export const handler = resolver.getDefinitions();
