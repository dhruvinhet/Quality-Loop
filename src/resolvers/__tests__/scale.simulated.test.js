// SIMULATED: mocked Jira latency, permissions, pagination and CAPA populations.
jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn() },
  route: (strings, ...values) => strings.reduce((s, part, i) => s + part + (values[i] ?? ''), '') }));
jest.mock('../decisionStore', () => ({
  PAIR_ENTITY: 'pair-state', DECISION_ENTITY: 'decision', getPairState: jest.fn(async () => ({ version: 0, state: 'NONE' })),
  queryRecords: jest.fn(async () => ({ records: [], incomplete: false })), pairConfirmed: jest.fn(),
}));
const api = require('@forge/api').default;
const { handler } = require('../index');
const { loadBudget } = require('../loadBudget');
const { findMatches } = require('../evidence');
const context = { extension: { issue: { id: '1' } } };
const nc = { schemaVersion: 2, recordType: 'NC', partOriginal: 'P-4471-A', supplier: 'Supplier', failureMode: 'FM-01', detectedDate: '2026-10-31' };
const issue = (id, capture) => ({ id: String(id), key: `QL-${id}`, fields: { summary: 'Visible', status: { name: 'Done' } }, properties: { qualityloop: capture } });
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: jest.fn(async () => data) });
let requestJira;
let hidden;
let failure;
let changed;
let corpus;
function seed(n) {
  corpus = Array.from({ length: n }, (_, i) => {
    const kind = i % 5;
    return issue(100 + i, { ...nc, recordType: 'CAPA', closedDate: '2026-10-01',
      partOriginal: kind === 1 ? 'P-4471-B' : kind >= 3 ? `P-${9000 + i}-A` : 'P-4471-A',
      failureMode: kind === 2 ? 'FM-02' : 'FM-01', supplier: kind === 4 ? 'Different' : 'Supplier' });
  });
}
beforeEach(() => {
  hidden = new Map(); failure = null; changed = new Map(); seed(0);
  requestJira = jest.fn(async (path, options) => {
    if (failure?.path === path) return response(failure.status, { secret: 'SECRET' });
    if (path.endsWith('/properties/qualityloop')) return response(200, { value: nc });
    if (path === '/rest/api/3/search/jql') {
      const { jql, maxResults, nextPageToken } = JSON.parse(options.body);
      let rows = corpus.filter((row) => !hidden.has(`search:${row.id}`));
      if (jql.includes('qlPartBase =')) rows = rows.filter((row) => ['P-4471-A', 'P-4471-B'].includes(row.properties.qualityloop.partOriginal) && row.properties.qualityloop.failureMode === 'FM-01');
      else if (jql.includes('qlPart =')) rows = rows.filter((row) => row.properties.qualityloop.partOriginal === 'P-4471-A' && row.properties.qualityloop.failureMode !== 'FM-01');
      else rows = rows.filter((row) => row.properties.qualityloop.partOriginal.startsWith('P-9') && row.properties.qualityloop.supplier === 'Supplier');
      const offset = Number(nextPageToken ?? 0);
      return response(200, { issues: rows.slice(offset, offset + maxResults), isLast: offset + maxResults >= rows.length,
        ...(offset + maxResults < rows.length ? { nextPageToken: String(offset + maxResults) } : {}) });
    }
    const id = path.match(/issue\/(\d+)\?/)[1];
    if (hidden.has(id)) return response(hidden.get(id), { secret: 'SECRET' });
    return response(200, changed.get(id) ?? (id === '1' ? issue(1, nc) : corpus.find((row) => row.id === id)));
  });
  api.asUser.mockReturnValue({ requestJira });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test.each([
  [0, 5, 0, 0, 0, false, false],
  [100, 85, 20, 20, 40, false, true],
  [500, 248, 100, 100, 40, false, true],
  [1000, 248, 100, 100, 40, true, true],
])('SIMULATED %i CAPAs: %i Jira calls per unified load', async (n, calls, strong, revision, other, matchesIncomplete, otherRelatedIncomplete) => {
  seed(n);
  const result = await handler.loadEvidence({ context });
  expect(result.error).toBeUndefined();
  expect(result.strong).toHaveLength(strong);
  expect(result.relatedRevision).toHaveLength(revision);
  expect(result.otherRelated).toHaveLength(other);
  expect(result).toMatchObject({ matchesIncomplete, otherRelatedIncomplete, incomplete: false });
  expect(requestJira).toHaveBeenCalledTimes(calls);
  for (const [path, options] of requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/search/jql')) {
    expect(path).toBe('/rest/api/3/search/jql');
    expect(JSON.parse(options.body)).toMatchObject({ properties: ['qualityloop'], fields: ['summary', 'status'] });
  }
});

test.each([403, 404])('SIMULATED hidden search records and revoked cards (%i) disclose no evidence or totals', async (status) => {
  seed(10); hidden.set('search:100', status); hidden.set('101', status);
  const result = await handler.loadEvidence({ context });
  expect([...result.strong, ...result.relatedRevision, ...result.otherRelated].map(({ id }) => id)).not.toEqual(expect.arrayContaining(['100', '101']));
  expect(result.strong.some(({ id }) => id === '100')).toBe(false);
  expect(result.relatedRevision.some(({ id }) => id === '101')).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|total/);
});

test('SIMULATED cards that changed classification are dropped, never moved into another class', async () => {
  seed(5);
  changed.set('100', issue(100, { ...corpus[0].properties.qualityloop, partOriginal: 'P-4471-B' }));
  const result = await handler.loadEvidence({ context });
  expect([...result.strong, ...result.relatedRevision].some(({ id }) => id === '100')).toBe(false);
});

test.each([429, 500, 503])('SIMULATED HTTP %i maps to busy/retry with no retry loop', async (status) => {
  failure = { path: '/rest/api/3/search/jql', status };
  expect(await handler.loadEvidence({ context })).toEqual({ error: 'Jira is busy, retry the request.' });
  expect(requestJira).toHaveBeenCalledTimes(2);
});
test.each([429, 500, 503])('SIMULATED selected-card HTTP %i also reports busy without stale evidence', async (status) => {
  seed(5);
  failure = { path: '/rest/api/3/issue/100?fields=summary,status&properties=qualityloop', status };
  expect(await handler.loadEvidence({ context })).toEqual({ error: 'Jira is busy, retry the request.' });
  expect(requestJira.mock.calls.filter(([path]) => path === failure.path)).toHaveLength(1);
});
test.each([429, 500, 503])('SIMULATED context-property HTTP %i reports busy before searching', async (status) => {
  failure = { path: '/rest/api/3/issue/1/properties/qualityloop', status };
  expect(await handler.loadEvidence({ context })).toEqual({ error: 'Jira is busy, retry the request.' });
  expect(requestJira).toHaveBeenCalledTimes(1);
});
test('SIMULATED search values that do not classify cause no candidate GETs', async () => {
  seed(1000);
  for (const row of corpus) row.properties.qualityloop.closedDate = nc.detectedDate;
  const result = await handler.loadEvidence({ context });
  expect(result).toMatchObject({ strong: [], relatedRevision: [], otherRelated: [], matchesIncomplete: true });
  expect(requestJira.mock.calls.filter(([path]) => /issue\/\d+\?/.test(path))).toHaveLength(1); // NC only
});
test.each([403, 404])('SIMULATED search HTTP %i returns nothing', async (status) => {
  failure = { path: '/rest/api/3/search/jql', status };
  expect(await handler.loadEvidence({ context })).toBeNull();
});
test('SIMULATED time budget keeps only completed verified batches and stops issuing reads', async () => {
  seed(500);
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  const read = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (...args) => {
    const result = await read(...args);
    if (args[0].includes('/issue/111?')) clock = 15001;
    return result;
  });
  const result = await findMatches('1', loadBudget());
  expect(result.incomplete).toBe(true);
  expect(result.strong.length + result.relatedRevision.length).toBe(5);
  expect(result.otherRelated).toEqual([]);
  expect(requestJira.mock.calls.filter(([path]) => path.includes('/issue/') && path.includes('?'))).toHaveLength(10);
});
test('SIMULATED a hanging Jira read ends at 15 seconds, below the UI limit', async () => {
  jest.useFakeTimers();
  requestJira.mockImplementation(() => new Promise(() => {}));
  const pending = handler.loadEvidence({ context });
  await jest.advanceTimersByTimeAsync(15000);
  expect(await pending).toMatchObject({ incomplete: true, decisionsIncomplete: true, strong: [], pairs: {} });
  expect(requestJira).toHaveBeenCalledTimes(1);
});
