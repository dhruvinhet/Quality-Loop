// SIMULATED: real resolver/store logic with in-memory Jira and custom entities.
jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn() },
  route: (strings, ...values) => strings.reduce((s, part, i) => s + part + (values[i] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ ...jest.requireActual('@forge/kvs'), kvs: { entity: jest.fn(), transact: jest.fn() } }));
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const { TransactionBuilderImpl } = require('@forge/kvs/out/transaction-api');
const { handler } = require('../index');
const context = { extension: { issue: { id: '1' } } };
const nc = { schemaVersion: 2, recordType: 'NC', partOriginal: 'P-4471-A', failureMode: 'FM-01', detectedDate: '2026-10-31' };
const issue = (id) => ({ id, key: `QL-${id}`, fields: { summary: 'Visible', status: { name: 'Done', statusCategory: { key: 'done' } } },
  properties: { qualityloop: id === '1' ? nc : { ...nc, recordType: 'CAPA', closedDate: '2026-10-01' } } });
const response = (data) => ({ status: 200, ok: true, json: async () => data });

test('SIMULATED 3 CAPAs / 15 legacy decisions: Jira and storage calls, initial and repeat load', async () => {
  const records = new Map();
  const counts = { jira: 0, storageGet: 0, storageQuery: 0, storageTransaction: 0 };
  for (const capaId of ['2', '3', '4']) {
    for (let i = 0; i < 5; i++) records.set(`decision/${capaId}:1:d${i}`, {
      capaId, issueId: '1', type: i === 0 ? 'CONFIRM' : 'CONCERN', authorAccountId: 'engineer', reason: 'Evidence reviewed',
      evidenceLinks: [], createdAt: `2026-10-${20 + i}T00:00:00Z`,
    });
    records.set(`pair-state/${capaId}:1`, { capaId, issueId: '1', version: 5, state: 'CONCERN_RAISED',
      latestDecisionId: `${capaId}:1:d4`, updatedAt: '2026-10-24T00:00:00Z' });
  }
  kvs.entity.mockImplementation((entity) => ({
    get: async (key) => { counts.storageGet++; return records.get(`${entity}/${key}`); },
    query: () => {
      let index, partition, filter;
      const query = {
        index: (value, options) => { index = value; partition = options.partition[0]; return query; },
        sort: () => query, limit: () => query, cursor: () => query,
        filters: (value) => { filter = value.filters(); return query; },
        getMany: async () => {
          counts.storageQuery++;
          const rows = [...records].filter(([key, value]) => key.startsWith(`${entity}/`) && value[index === 'by-capa' ? 'capaId' : 'issueId'] === partition
            && (!filter || value.capaId === filter[0].values[0]));
          return { results: rows.map(([key, value]) => ({ key: key.slice(entity.length + 1), value })) };
        },
      };
      return query;
    },
  }));
  kvs.transact.mockImplementation(() => new TransactionBuilderImpl({ transact: async ({ set }) => {
    counts.storageTransaction++;
    for (const op of set) {
      const previous = records.get(`${op.entityName}/${op.key}`);
      for (const c of op.conditions?.and ?? []) {
        if (c.condition === 'EQUAL_TO' && previous?.[c.property] !== c.values[0]) throw new Error('Conflict');
      }
    }
    for (const op of set) records.set(`${op.entityName}/${op.key}`, op.value);
  } }));
  api.asUser.mockReturnValue({ requestJira: async (path, options) => {
    counts.jira++;
    if (path.endsWith('/properties/qualityloop')) return response({ value: nc });
    if (path === '/rest/api/3/search/jql') return response({ issues: JSON.parse(options.body).jql.includes('qlPartBase =') ? ['2', '3', '4'].map(issue) : [], isLast: true });
    if (path.startsWith('/rest/api/3/user?')) return response({ displayName: 'Engineer' });
    return response(issue(path.match(/issue\/(\d+)/)[1]));
  } });
  const first = await handler.loadEvidence({ context });
  expect(first.error).toBeUndefined();
  expect(Object.values(first.pairs)).toHaveLength(3);
  expect(Object.values(first.pairs).map((pair) => pair.history.length)).toEqual([5, 5, 5]);
  expect(Object.values(first.pairs).map((pair) => pair.confirmedCount)).toEqual([1, 1, 1]);
  const initial = { ...counts };
  expect(initial).toEqual({ jira: 8, storageGet: 3, storageQuery: 7, storageTransaction: 3 });
  for (const key of Object.keys(counts)) counts[key] = 0;
  await handler.loadEvidence({ context });
  expect(counts).toEqual({ jira: 8, storageGet: 3, storageQuery: 7, storageTransaction: 0 });
  console.log('SIMULATED 3 CAPAs / 15 decisions:', JSON.stringify({ initial, repeat: counts }));
});
