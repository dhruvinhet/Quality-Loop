import { kvs, Filter, FilterConditions } from '@forge/kvs';
import { RECORD_ENTITIES, recordReferences, recordsForIssues } from '../lib/cleanup';

export const STORAGE_PAGE_SIZE = 10;

export async function recordPage(entity, cursor, index = 'by-key', partition) {
  if (!RECORD_ENTITIES.includes(entity)) throw new Error('Invalid record entity.');
  let query = kvs.entity(entity).query().index(index, partition ? { partition: [partition] } : undefined).limit(STORAGE_PAGE_SIZE);
  if (cursor) query = query.cursor(cursor);
  const page = await query.getMany();
  // Queries can lag writes/deletes. Always operate on the strictly consistent value.
  const records = [];
  for (const { key } of page.results) {
    const value = await kvs.entity(entity).get(key);
    if (value) records.push({ entity, key, value });
  }
  return { records, nextCursor: page.nextCursor };
}

export async function deleteRecordBatch(records) {
  // The documented transaction limit is 25 operations and one use per unique key.
  // Separate entities also avoid any duplicate-key restriction across namespaces.
  for (const entity of RECORD_ENTITIES) {
    const keys = [...new Set(records.filter((r) => r.entity === entity).map((r) => r.key))];
    for (let offset = 0; offset < keys.length; offset += 25) {
      let transaction = kvs.transact();
      for (const key of keys.slice(offset, offset + 25)) transaction = transaction.delete(key, { entityName: entity });
      await transaction.execute();
    }
  }
}

export async function backfillPair(record) {
  if (record.entity !== 'pair-state') return false;
  const [issueId, capaId] = recordReferences(record.entity, record.key, record.value);
  if (!issueId || !capaId) return false;
  const current = await kvs.entity('pair-state').get(record.key);
  if (!current || (current.issueId === issueId && current.capaId === capaId)) return false;
  // A concurrent T4 decision wins; never overwrite its state or resurrect a deletion.
  await kvs.transact().set(record.key, { ...current, issueId, capaId }, {
    entityName: 'pair-state',
    conditions: new Filter().and('version', FilterConditions.equalTo(current.version)),
  }).execute();
  return true;
}

export async function cleanupIssueRecords(issueId) {
  const deadline = Date.now() + 18000;
  const checkBudget = () => { if (Date.now() >= deadline) throw new Error('Cleanup time budget reached; use the admin orphan scan.'); };
  let failed = false;
  for (const entity of RECORD_ENTITIES) {
    for (const index of ['by-issue', 'by-capa']) {
      let cursor;
      try {
        do {
          checkBudget();
          const page = await recordPage(entity, cursor, index, issueId);
          await deleteRecordBatch(recordsForIssues(page.records, [issueId]));
          cursor = page.nextCursor;
        } while (cursor);
      } catch (error) {
        failed = true;
        console.error('QualityLoop indexed cleanup incomplete:', entity, index, error.message);
      }
    }
  }
  // Covers legacy records before backfill and recently written records whose new indexes lag.
  // Bounded best effort; the admin page is the repair path for large installations.
  for (const entity of RECORD_ENTITIES) {
    let cursor;
    try {
      do {
        checkBudget();
        const page = await recordPage(entity, cursor);
        await deleteRecordBatch(recordsForIssues(page.records, [issueId]));
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      failed = true;
      console.error('QualityLoop cleanup scan incomplete:', entity, error.message);
    }
  }
  return { complete: !failed };
}

// Product events execute in app context. No Jira call is made by this handler.
export async function onIssueDeleted(event) {
  try {
    if (event?.eventType !== 'avi:jira:deleted:issue' || event.selfGenerated || !/^\d{1,30}$/.test(event.issue?.id ?? '')) return;
    await cleanupIssueRecords(event.issue.id);
  } catch (error) {
    console.error('QualityLoop issue deletion cleanup incomplete:', error.message);
  }
}
