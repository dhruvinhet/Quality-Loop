jest.mock('@forge/kvs', () => ({ ...jest.requireActual('@forge/kvs'), kvs: { entity: jest.fn(), transact: jest.fn() } }));
const { kvs } = require('@forge/kvs');
const { TransactionBuilderImpl } = require('@forge/kvs/out/transaction-api');
const { commitDecision, claimTask, queryDecisions } = require('../decisionStore');

const payload = { capaId: '20002', expectedVersion: 0, type: 'CONFIRM', reason: 'Review evidence', evidenceLinks: [] };
const args = { issueId: '10001', authorAccountId: 'server-account', payload, capa: {} };
let records;
let transact;
let entityGet;
beforeEach(() => {
  jest.clearAllMocks();
  records = new Map();
  entityGet = jest.fn(async (entity, key) => records.get(`${entity}/${key}`));
  kvs.entity.mockImplementation((entity) => ({ get: (key) => entityGet(entity, key) }));
  transact = jest.fn(async (request) => {
    // Test the shipped SDK's serialization, and simulate an atomic storage CAS.
    for (const op of request.set) {
      const existing = records.get(`${op.entityName}/${op.key}`);
      for (const condition of op.conditions?.and ?? []) {
        const value = existing?.[condition.property];
        if ((condition.condition === 'NOT_EXISTS' && value !== undefined) ||
            (condition.condition === 'EQUAL_TO' && value !== condition.values[0])) throw new Error('Condition rejected');
      }
    }
    for (const op of request.set) records.set(`${op.entityName}/${op.key}`, op.value);
  });
  kvs.transact.mockImplementation(() => new TransactionBuilderImpl({ transact }));
});
test('pair and immutable decision commit in one transaction with a missing-version condition', async () => {
  const result = await commitDecision(args);
  expect(result).toMatchObject({ success: true, pairState: { version: 1, state: 'CONFIRMED' },
    decision: { authorAccountId: 'server-account', issueId: '10001', capaId: '20002', type: 'CONFIRM' } });
  const writes = transact.mock.calls[0][0].set;
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ entityName: 'pair-state', key: '20002:10001',
    conditions: { and: [{ property: 'version', condition: 'NOT_EXISTS', values: [true] }] } });
  expect(writes[1].key).toMatch(/^20002:10001:\d{13}-[a-f0-9-]{36}$/);
  expect(records.size).toBe(2);
});
test('ten races from identical expected versions each commit exactly once', async () => {
  for (let version = 0; version < 10; version += 1) {
    const input = { ...args, payload: { ...payload, expectedVersion: version } };
    const results = await Promise.all([commitDecision(input), commitDecision(input)]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.conflict)).toHaveLength(1);
    expect(results.find((r) => r.conflict).pairState.version).toBe(version + 1);
  }
  expect(records.get('pair-state/20002:10001').version).toBe(10);
  expect([...records.keys()].filter((key) => key.startsWith('decision/'))).toHaveLength(10);
  expect(transact.mock.calls[2][0].set[0].conditions.and[0]).toMatchObject({ condition: 'EQUAL_TO', values: [1] });
});
test('stale version returns current pair state without a transaction', async () => {
  records.set('pair-state/20002:10001', { version: 5, state: 'NOT_RECURRENCE' });
  expect(await commitDecision(args)).toEqual({ conflict: true, pairState: { version: 5, state: 'NOT_RECURRENCE' } });
  expect(transact).not.toHaveBeenCalled();
});
test('storage outage is not reported as a conflict and writes no partial data', async () => {
  transact.mockRejectedValue(new Error('Storage unavailable'));
  await expect(commitDecision(args)).rejects.toThrow('Storage unavailable');
  expect(records.size).toBe(0);
});
test('reconciles a committed transaction whose response was lost', async () => {
  const atomic = transact.getMockImplementation();
  transact.mockImplementation(async (request) => { await atomic(request); throw new Error('Connection interrupted'); });
  expect(await commitDecision(args)).toMatchObject({ success: true, pairState: { version: 1 } });
  expect(records.size).toBe(2);
});
test('ineligible CONCERN and SUPERSEDE cannot write', async () => {
  await expect(commitDecision({ ...args, payload: { ...payload, type: 'CONCERN' }, capa: { effectivenessEvidenceUrl: 'https://example.com' } })).rejects.toThrow();
  await expect(commitDecision({ ...args, payload: { ...payload, type: 'SUPERSEDE' } })).rejects.toThrow();
  expect(transact).not.toHaveBeenCalled();
});
test('follow-up can only be claimed once even across simultaneous requests', async () => {
  const id = '20002:10001:1793400000000-12345678-1234-1234-1234-123456789abc';
  const decision = { type: 'CONCERN', reason: 'Review evidence' };
  records.set(`decision/${id}`, decision);
  const result = await Promise.all([claimTask(id, decision), claimTask(id, decision)]);
  expect(result.filter(Boolean)).toHaveLength(1);
  expect(result.filter((r) => r === null)).toHaveLength(1);
});
test('history index traverses cursors, including an empty intermediate page', async () => {
  const getMany = jest.fn().mockResolvedValueOnce({ results: [], nextCursor: 'next' })
    .mockResolvedValueOnce({ results: [{ key: 'id', value: { reason: 'Review' } }] });
  const query = { index: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), cursor: jest.fn().mockReturnThis(), getMany };
  kvs.entity.mockReturnValue({ query: () => query });
  expect(await queryDecisions('by-issue', '10001')).toEqual([{ id: 'id', reason: 'Review' }]);
  expect(query.index).toHaveBeenCalledWith('by-issue', { partition: ['10001'] });
  expect(query.cursor).toHaveBeenCalledWith('next');
});
