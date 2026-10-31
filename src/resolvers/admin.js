import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { detectOrphans, RECORD_ENTITIES } from '../lib/cleanup';
import { backfillPair, deleteRecordBatch, recordPage } from './cleanupStore';
import { pageDefine, readTicket, requireAdmin, saveTicket, validCursor } from './pageUtils';

const resolver = new Resolver();
// T5 explicitly permits asApp existence checks here. Return status-derived IDs
// only to a freshly authorised Jira admin, never Jira fields or response bodies.
const existence = (id) => api.asApp().requestJira(route`/rest/api/3/issue/${id}?fields=id`);

pageDefine(resolver, 'startOrphanScan', [], async (context) => {
  if (!await requireAdmin(context)) return null;
  return { token: await saveTicket('orphan-scan', context, {}) };
});

pageDefine(resolver, 'findOrphanPage', ['token', 'entity', 'cursor'], async (context, { token, entity, cursor }) => {
  if (!await requireAdmin(context)) return null;
  if (!await readTicket('orphan-scan', token, context)) return { error: 'The scan expired. Find orphaned records again.' };
  if (!RECORD_ENTITIES.includes(entity) || !validCursor(cursor)) return { error: 'Invalid scan page.' };
  const page = await recordPage(entity, cursor);
  let backfilled = 0;
  let backfillPending = 0;
  for (const record of page.records) {
    try { if (await backfillPair(record)) backfilled += 1; }
    catch (error) {
      backfillPending += 1;
      console.error('QualityLoop pair-state backfill deferred:', error.message);
    }
  }
  // The same issue may occur on many pages and in both entities. Cache only its
  // status for this scan, with separate keys to keep each value below KVS limits.
  const checked = async (id) => {
    const key = `orphan-existence:${token}:${id}`;
    const cached = await kvs.get(key);
    if (cached) return { status: cached.status, ok: cached.status >= 200 && cached.status < 300 };
    const response = await existence(id);
    await kvs.set(key, { status: response.status }, { ttl: { unit: 'HOURS', value: 1 } });
    return response;
  };
  const result = await detectOrphans(page.records, checked);
  const reviewToken = result.records.length ? await saveTicket('orphan-review', context, {
    records: result.records.map(({ entity: name, key }) => ({ entity: name, key })),
  }) : undefined;
  return { entity, scanned: page.records.length, orphanCount: result.records.length,
    recordIds: result.records.map(({ key }) => key), missingIds: result.missingIds,
    unknownIds: result.unknownIds, nextCursor: page.nextCursor, token: reviewToken, backfilled, backfillPending };
});

pageDefine(resolver, 'deleteOrphanPage', ['token', 'confirmed'], async (context, { token, confirmed }) => {
  if (!await requireAdmin(context)) return null;
  if (confirmed !== true) return { error: 'Confirm the listed app-record deletions first.' };
  const ticket = await readTicket('orphan-review', token, context);
  if (!ticket) return { error: 'This review expired. Find orphaned records again.' };
  const records = [];
  for (const { entity, key } of ticket.records) {
    const value = await kvs.entity(entity).get(key);
    if (value) records.push({ entity, key, value });
  }
  // Recheck immediately before deleting. Permission failures never select a record.
  const result = await detectOrphans(records, existence);
  await deleteRecordBatch(result.records);
  await kvs.delete(`orphan-review:${token}`);
  return { deleted: result.records.length, retained: records.length - result.records.length };
});

export const handler = resolver.getDefinitions();
