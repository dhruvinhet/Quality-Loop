jest.mock('@forge/kvs', () => ({ ...jest.requireActual('@forge/kvs'), kvs: { entity: jest.fn(), transact: jest.fn() } }));
const { kvs } = require('@forge/kvs');
const { TransactionBuilderImpl } = require('@forge/kvs/out/transaction-api');
const { backfillPair, deleteRecordBatch, onIssueDeleted, recordPage } = require('../cleanupStore');

let records;
let transact;
beforeEach(() => {
  jest.clearAllMocks();
  records = new Map();
  kvs.entity.mockImplementation((entity) => ({ get: async (key) => records.get(`${entity}/${key}`) }));
  transact = jest.fn(async (request) => {
    for (const op of request.set ?? []) {
      const old = records.get(`${op.entityName}/${op.key}`);
      for (const condition of op.conditions?.and ?? []) {
        if (old?.[condition.property] !== condition.values[0]) throw new Error('Version changed');
      }
      records.set(`${op.entityName}/${op.key}`, op.value);
    }
  });
  kvs.transact.mockImplementation(() => new TransactionBuilderImpl({ transact }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('backfill uses the legacy key and is idempotent without changing state or version', async () => {
  const value = { version: 8, state: 'CONCERN_RAISED', latestDecisionId: 'latest', updatedAt: '2026-10-31' };
  records.set('pair-state/20:10', value);
  const record = { entity: 'pair-state', key: '20:10', value };
  expect(await backfillPair(record)).toBe(true);
  expect(records.get('pair-state/20:10')).toEqual({ ...value, issueId: '10', capaId: '20' });
  expect(await backfillPair(record)).toBe(false);
  expect(transact).toHaveBeenCalledTimes(1);
});
test('backfill does not resurrect a deleted record', async () => {
  expect(await backfillPair({ entity: 'pair-state', key: '20:10', value: { version: 1 } })).toBe(false);
  expect(transact).not.toHaveBeenCalled();
});
test('backfill cannot overwrite a concurrent decision', async () => {
  records.set('pair-state/20:10', { version: 1, state: 'CONFIRMED' });
  const atomic = transact.getMockImplementation();
  transact.mockImplementation(async (request) => {
    records.set('pair-state/20:10', { version: 2, state: 'NOT_RECURRENCE', issueId: '10', capaId: '20' });
    await atomic(request);
  });
  await expect(backfillPair({ entity: 'pair-state', key: '20:10', value: {} })).rejects.toThrow('Version changed');
  expect(records.get('pair-state/20:10').state).toBe('NOT_RECURRENCE');
});
test('storage deletion uses at most 25 operations per transaction and deduplicates keys', async () => {
  const input = Array.from({ length: 53 }, (_, index) => ({ entity: 'decision', key: `record-${index}` }));
  await deleteRecordBatch([...input, input[0], { entity: 'pair-state', key: '20:10' }]);
  const batches = transact.mock.calls.map(([request]) => request.delete);
  expect(batches.map((batch) => batch.length)).toEqual([25, 25, 3, 1]);
});
test('storage page uses the documented cursor and ignores stale deleted query results', async () => {
  records.set('decision/live', { issueId: '10', capaId: '20' });
  const query = { index: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), cursor: jest.fn().mockReturnThis(),
    getMany: async () => ({ results: [{ key: 'deleted' }, { key: 'live' }], nextCursor: 'next' }) };
  kvs.entity.mockReturnValue({ query: () => query, get: async (key) => records.get(`decision/${key}`) });
  expect(await recordPage('decision', 'previous')).toEqual({
    records: [{ entity: 'decision', key: 'live', value: { issueId: '10', capaId: '20' } }], nextCursor: 'next',
  });
  expect(query.index).toHaveBeenCalledWith('by-key', undefined);
  expect(query.cursor).toHaveBeenCalledWith('previous');
});
test('issue deletion event is best effort and never throws on storage failure', async () => {
  kvs.entity.mockImplementation(() => { throw new Error('offline'); });
  await expect(onIssueDeleted({ eventType: 'avi:jira:deleted:issue', issue: { id: '10' } })).resolves.toBeUndefined();
  expect(console.error).toHaveBeenCalled();
});
test('self-generated and malformed events do nothing', async () => {
  await onIssueDeleted({ eventType: 'avi:jira:deleted:issue', selfGenerated: true, issue: { id: '10' } });
  await onIssueDeleted({ eventType: 'avi:jira:deleted:issue', issue: { id: 'bad' } });
  await onIssueDeleted({ eventType: 'avi:jira:updated:issue', issue: { id: '10' } });
  expect(kvs.entity).not.toHaveBeenCalled();
});
