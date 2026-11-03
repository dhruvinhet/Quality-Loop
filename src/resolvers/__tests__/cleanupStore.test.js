jest.mock('@forge/kvs', () => ({ ...jest.requireActual('@forge/kvs'), kvs: { entity: jest.fn(), transact: jest.fn() } }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asApp: jest.fn() },
  route: (parts, ...values) => parts.reduce((text, part, i) => text + part + (values[i] ?? ''), '') }));
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const { TransactionBuilderImpl } = require('@forge/kvs/out/transaction-api');
const { backfillPair, deleteRecordBatch, onIssueDeleted, recordPage, cleanupProjectOrphans } = require('../cleanupStore');

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
    for (const op of request.delete ?? []) records.delete(`${op.entityName}/${op.key}`);
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

function projectScan() {
  const requestJira = jest.fn(async (path) => {
    if (path.includes('mypermissions')) return { status: 200, json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } }) };
    if (path.includes('/project/search?')) return { status: 200, json: async () => ({ startAt: 0, total: 0, isLast: true, values: [] }) };
    return { status: path.includes('/20?') ? 404 : 200, json: () => { throw new Error('Issue bodies must not be read'); } };
  });
  api.asApp.mockReturnValue({ requestJira });
  kvs.entity.mockImplementation((entity) => ({
    get: async (key) => records.get(`${entity}/${key}`),
    query: () => {
      let cursor = '', size = 10;
      const query = { index: () => query, limit: (limit) => { size = limit; return query; },
        cursor: (value) => { cursor = value; return query; }, getMany: async () => {
          const keys = [...records.keys()].filter((key) => key.startsWith(`${entity}/`)).map((key) => key.slice(entity.length + 1))
            .sort().filter((key) => key > cursor);
          const page = keys.slice(0, size);
          return { results: page.map((key) => ({ key })), ...(keys.length > size ? { nextCursor: page.at(-1) } : {}) };
        } };
      return query;
    },
  }));
  return requestJira;
}

test.each(['avi:jira:deleted:project'])(
  '%s uses the existing handler to clean legacy references over multiple pages and both entities', async (eventType) => {
    for (let i = 0; i < 12; i++) records.set(`decision/d${i}`, { issueId: '10', capaId: '20' });
    records.set('pair-state/20:10', { version: 1 });
    records.set('decision/live', { issueId: '11', capaId: '21' });
    const request = projectScan();
    await onIssueDeleted({ eventType, project: { id: '123' } });
    expect([...records.keys()]).toEqual(['decision/live']);
    expect(request.mock.calls.some(([path]) => path.includes('/project/search?status=deleted'))).toBe(true);
    expect(transact.mock.calls.flatMap(([value]) => value.delete ?? [])).toHaveLength(13);
  });

test.each([403, 500])('project cleanup keeps HTTP %i references and reports an incomplete check', async (status) => {
  records.set('decision/kept', { issueId: '10', capaId: '20' });
  projectScan().mockResolvedValue({ status });
  expect(await cleanupProjectOrphans()).toEqual({ complete: false });
  expect(records.has('decision/kept')).toBe(true);
  expect(transact).not.toHaveBeenCalled();
});

test('project cleanup shares an 18-second budget and leaves unfinished records for admin repair', async () => {
  records.set('decision/kept', { issueId: '10', capaId: '20' });
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  projectScan().mockImplementation(async () => { clock = 18001; return { status: 404 }; });
  expect(await cleanupProjectOrphans()).toEqual({ complete: false });
  expect(records.has('decision/kept')).toBe(true);
  expect(transact).not.toHaveBeenCalled();
});

test('unrelated, self-generated and malformed project events do no cleanup', async () => {
  for (const event of [
    { eventType: 'avi:jira:deleted:project', project: { id: 'bad' } },
    { eventType: 'avi:jira:softdeleted:project', project: { id: '123' }, selfGenerated: true },
    { eventType: 'avi:jira:restored:project', project: { id: '123' } },
  ]) await onIssueDeleted(event);
  expect(kvs.entity).not.toHaveBeenCalled();
  expect(api.asApp).not.toHaveBeenCalled();
});

test('soft-delete events do nothing even with valid records and an app-context 404', async () => {
  records.set('decision/keep-on-restore', { issueId: '10', capaId: '20' });
  records.set('pair-state/20:10', { version: 1 });
  projectScan();
  await onIssueDeleted({ eventType: 'avi:jira:softdeleted:project', project: { id: '123' } });
  expect(records.size).toBe(2);
  expect(kvs.entity).not.toHaveBeenCalled();
  expect(api.asApp).not.toHaveBeenCalled();
  expect(transact).not.toHaveBeenCalled();
});

test('permanent deletion of one project never purges references while another project is in trash', async () => {
  records.set('decision/keep-in-trash', { issueId: '10', capaId: '20' });
  const request = projectScan();
  const original = request.getMockImplementation();
  request.mockImplementation(async (path) => path.includes('/project/search?')
    ? { status: 200, json: async () => ({ startAt: 0, total: 1, isLast: true, values: [{ id: '456', deleted: true }] }) }
    : original(path));
  await onIssueDeleted({ eventType: 'avi:jira:deleted:project', project: { id: '123' } });
  expect(records.has('decision/keep-in-trash')).toBe(true);
  expect(transact).not.toHaveBeenCalled();
});

test('permanent cleanup retains missing references when app permissions cannot establish a complete trash check', async () => {
  records.set('decision/keep-uncertain', { issueId: '10', capaId: '20' });
  const request = projectScan();
  const original = request.getMockImplementation();
  request.mockImplementation(async (path) => path.includes('mypermissions')
    ? { status: 200, json: async () => ({ permissions: { ADMINISTER: { havePermission: false } } }) } : original(path));
  expect(await cleanupProjectOrphans()).toEqual({ complete: false });
  expect(records.has('decision/keep-uncertain')).toBe(true);
  expect(request.mock.calls.some(([path]) => path.includes('/project/search?'))).toBe(false);
  expect(transact).not.toHaveBeenCalled();
});
