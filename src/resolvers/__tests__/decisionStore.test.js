jest.mock('@forge/kvs', () => ({ ...jest.requireActual('@forge/kvs'), kvs: { entity: jest.fn(), transact: jest.fn() } }));
const { kvs } = require('@forge/kvs');
const { TransactionBuilderImpl } = require('@forge/kvs/out/transaction-api');
const { commitDecision, claimTask, queryRecords, pairConfirmed, saveTaskMetadata } = require('../decisionStore');

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
  expect(records.get('pair-state/20002:10001').confirmed).toBe(true);
  expect([...records.keys()].filter((key) => key.startsWith('pair-state/'))).toHaveLength(1);
  expect([...records.keys()].filter((key) => key.startsWith('decision/'))).toHaveLength(10);
  expect(transact.mock.calls[2][0].set[0].conditions.and[0]).toMatchObject({ condition: 'EQUAL_TO', values: [1] });
});

test.each([
  [['CONFIRM', 'NOT_RECURRENCE'], false],
  [['CONFIRM', 'CONCERN'], true],
  [['CONFIRM', 'SUPERSEDE'], true],
  [['CONFIRM', 'NOT_RECURRENCE', 'SUPERSEDE'], false],
])('confirmed boolean follows %j atomically and survives explanation/concern writes', async (types, confirmed) => {
  for (let version = 0; version < types.length; version += 1) {
    expect(await commitDecision({ ...args, payload: { ...payload, type: types[version], expectedVersion: version } })).toHaveProperty('success', true);
  }
  expect(records.get('pair-state/20002:10001').confirmed).toBe(confirmed);
  const events = [...records.entries()].filter(([key]) => key.startsWith('decision/')).map(([, event]) => event.createdAt);
  expect(new Set(events).size).toBe(types.length);
});

function mockQuery(pages) {
  const getMany = jest.fn();
  for (const page of pages) getMany.mockResolvedValueOnce(page);
  const query = { index: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
    filters: jest.fn().mockReturnThis(), cursor: jest.fn().mockReturnThis(), getMany };
  kvs.entity.mockImplementation((entity) => ({ query: () => query, get: (key) => entityGet(entity, key) }));
  return query;
}

test('bounded history query traverses empty filter pages, sorts newest first, and discloses its cap', async () => {
  const query = mockQuery([{ results: [], nextCursor: 'next' }, { results: [{ key: 'd', value: { type: 'CONFIRM' } }], nextCursor: 'older' }]);
  expect(await queryRecords('decision', 'by-issue', '10001', { capaId: '20002', limit: 1 }))
    .toEqual({ records: [{ id: 'd', type: 'CONFIRM' }], incomplete: true });
  expect(query.sort).toHaveBeenCalledWith('DESC');
  expect(query.filters).toHaveBeenCalled();
  expect(query.cursor).toHaveBeenCalledWith('next');
});
test('bounded history stops after ten empty filter pages', async () => {
  const query = mockQuery(Array.from({ length: 10 }, () => ({ results: [], nextCursor: 'next' })));
  expect(await queryRecords('decision', 'by-issue', '10001', { capaId: '20002' })).toEqual({ records: [], incomplete: true });
  expect(query.getMany).toHaveBeenCalledTimes(10);
});
test.each([
  [['CONCERN', 'SUPERSEDE', 'CONFIRM'], true],
  [['SUPERSEDE', 'NOT_RECURRENCE', 'CONFIRM'], false],
  [['CONCERN'], false],
])('legacy pair derives confirmation from its own history %j', async (types, confirmed) => {
  records.set('pair-state/20002:10001', { version: types.length });
  const query = mockQuery([{ results: types.map((type, index) => ({ key: `d${index}`, value: {
    type, capaId: '20002', issueId: '10001', createdAt: `2026-10-${String(31 - index).padStart(2, '0')}T00:00:00Z` } })) }]);
  expect(await pairConfirmed({ version: types.length }, '20002', '10001')).toBe(confirmed);
  expect(query.index).toHaveBeenCalledWith('by-issue', { partition: ['10001'] });
  expect(records.get('pair-state/20002:10001')).toMatchObject({ confirmed, version: types.length });
  expect(await pairConfirmed(records.get('pair-state/20002:10001'), '20002', '10001')).toBe(confirmed);
  expect(query.getMany).toHaveBeenCalledTimes(1);
});
test('legacy preserving write puts derived confirmed in the same version-conditional transaction', async () => {
  records.set('pair-state/20002:10001', { version: 2, state: 'CONCERN_RAISED' });
  mockQuery([{ results: [{ key: 'confirm', value: { type: 'CONFIRM', capaId: '20002', issueId: '10001', createdAt: '2026-10-01T00:00:00Z' } }] }]);
  const result = await commitDecision({ ...args, payload: { ...payload, expectedVersion: 2, type: 'SUPERSEDE' } });
  expect(result.pairState).toMatchObject({ confirmed: true, version: 3, state: 'CONCERN_RAISED' });
  expect(transact.mock.calls[0][0].set[0].conditions.and[0]).toMatchObject({ condition: 'EQUAL_TO', values: [2] });
});
test('capped legacy history with no decisive event is unavailable, never silently false', async () => {
  mockQuery(Array.from({ length: 10 }, () => ({ results: [], nextCursor: 'older' })));
  await expect(pairConfirmed({ version: 1000 }, '20002', '10001')).rejects.toThrow('incomplete');
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
  expect(result.find(Boolean).taskClaimedAt).toEqual(expect.any(String));
});

test('legacy backfill is conditional on the observed version and missing flag', async () => {
  const legacy = { version: 1, state: 'CONFIRMED', capaId: '20002', issueId: '10001' };
  records.set('pair-state/20002:10001', legacy);
  const knownHistory = { records: [{ id: 'd', type: 'CONFIRM', capaId: '20002', issueId: '10001', createdAt: '2026-10-21' }], incomplete: false };
  expect(await pairConfirmed(legacy, '20002', '10001', undefined, knownHistory)).toBe(true);
  expect(transact.mock.calls[0][0].set[0].conditions.and).toEqual([
    { property: 'version', condition: 'EQUAL_TO', values: [1] },
    { property: 'confirmed', condition: 'NOT_EXISTS', values: [true] },
  ]);
});

test('a concurrent newer decision cannot be overwritten by legacy backfill', async () => {
  const legacy = { version: 1, state: 'CONFIRMED' };
  const newer = { version: 2, state: 'NOT_RECURRENCE', confirmed: false };
  records.set('pair-state/20002:10001', newer);
  const history = { records: [{ id: 'd', type: 'CONFIRM', capaId: '20002', issueId: '10001', createdAt: '2026-10-21' }], incomplete: false };
  expect(await pairConfirmed(legacy, '20002', '10001', undefined, history)).toBe(false);
  expect(records.get('pair-state/20002:10001')).toEqual(newer);
});

test('backfill reconciles a committed transaction whose response was lost', async () => {
  const legacy = { version: 1, state: 'CONFIRMED' };
  records.set('pair-state/20002:10001', legacy);
  const atomic = transact.getMockImplementation();
  transact.mockImplementation(async (request) => { await atomic(request); throw new Error('Response lost'); });
  const history = { records: [{ id: 'd', type: 'CONFIRM', capaId: '20002', issueId: '10001', createdAt: '2026-10-21' }], incomplete: false };
  expect(await pairConfirmed(legacy, '20002', '10001', undefined, history)).toBe(true);
  expect(records.get('pair-state/20002:10001')).toMatchObject({ version: 1, confirmed: true });
});

test('task metadata cannot replace an already recorded task or another claim', async () => {
  const existing = { type: 'CONCERN', taskClaimId: 'claim', taskKey: 'QL-3' };
  records.set('decision/d', existing);
  expect(await saveTaskMetadata('d', { ...existing, taskKey: 'QL-4' })).toBe(false);
  expect(records.get('decision/d')).toEqual(existing);
  expect(await saveTaskMetadata('d', existing)).toBe(true);
  records.set('decision/d', { type: 'CONCERN', taskClaimId: 'different-claim' });
  expect(await saveTaskMetadata('d', { ...existing, taskKey: 'QL-4' })).toBe(false);
});
