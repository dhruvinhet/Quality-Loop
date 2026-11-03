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
const store = require('../decisionStore');
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
  [500, 98, 25, 25, 40, false, true],
  [1000, 98, 25, 25, 40, true, true],
])('SIMULATED %i CAPAs: %i Jira calls per unified load', async (n, calls, strong, revision, other, matchesIncomplete, otherRelatedIncomplete) => {
  seed(n);
  const result = await handler.loadEvidence({ context });
  expect(result.error).toBeUndefined();
  expect(result.strong).toHaveLength(strong);
  expect(result.relatedRevision).toHaveLength(revision);
  expect(result.otherRelated).toHaveLength(other);
  expect(result).toMatchObject({ matchesIncomplete, otherRelatedIncomplete, incomplete: false });
  expect(requestJira).toHaveBeenCalledTimes(calls);
  expect(result.notShown).toEqual({ strong: n >= 500 ? 75 : 0, relatedRevision: n >= 500 ? 75 : 0 });
  for (const [path, options] of requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/search/jql')) {
    expect(path).toBe('/rest/api/3/search/jql');
    expect(JSON.parse(options.body)).toMatchObject({ properties: ['qualityloop'], fields: ['summary', 'status'] });
  }
});

test('SIMULATED 25-card cap selects most recent closures before direct reads', async () => {
  corpus = Array.from({ length: 60 }, (_, i) => issue(100 + i, { ...nc, recordType: 'CAPA',
    partOriginal: i < 30 ? 'P-4471-A' : 'P-4471-B', closedDate: `2026-10-${String(i % 30 + 1).padStart(2, '0')}` }));
  // Deliberately unsorted snapshots verify that the server selects by closedDate.
  const result = await handler.loadEvidence({ context });
  for (const kind of ['strong', 'relatedRevision']) {
    expect(result[kind]).toHaveLength(25);
    expect(result[kind][0].closedDate).toBe('2026-10-30');
    expect(result[kind].at(-1).closedDate).toBe('2026-10-06');
    expect(result.notShown[kind]).toBe(5);
  }
  const directIds = requestJira.mock.calls.map(([path]) => path.match(/issue\/(\d+)\?/)?.[1]).filter(Boolean);
  expect(directIds).toHaveLength(51); // 50 displayed CAPAs + context NC
  expect(directIds).not.toContain('100');
  expect(directIds).not.toContain('130');
});

test('SIMULATED omitted signature cards are not fetched again through the historical-pair index', async () => {
  seed(500);
  store.queryRecords.mockImplementation(async (entity, index) => ({ records: entity === 'pair-state' && index === 'by-issue'
    ? [{ capaId: '225', issueId: '1' }, { capaId: '226', issueId: '1' }] : [], incomplete: false }));
  try {
    const result = await handler.loadEvidence({ context });
    expect(result.pairs['225']).toBeUndefined();
    expect(result.pairs['226']).toBeUndefined();
    expect(requestJira.mock.calls.some(([path]) => /issue\/(225|226)\?/.test(path))).toBe(false);
  } finally { store.queryRecords.mockImplementation(async () => ({ records: [], incomplete: false })); }
});

test.each([403, 404])('SIMULATED hidden search records and revoked cards (%i) disclose no evidence or totals', async (status) => {
  seed(10); hidden.set('search:100', status); hidden.set('101', status);
  const result = await handler.loadEvidence({ context });
  expect([...result.strong, ...result.relatedRevision, ...result.otherRelated].map(({ id }) => id)).not.toEqual(expect.arrayContaining(['100', '101']));
  expect(result.strong.some(({ id }) => id === '100')).toBe(false);
  expect(result.relatedRevision.some(({ id }) => id === '101')).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|total/);
});

test('SIMULATED signature cards move to their freshly re-read class in both directions', async () => {
  seed(5);
  changed.set('100', issue(100, { ...corpus[0].properties.qualityloop, partOriginal: 'P-4471-B' }));
  changed.set('101', issue(101, { ...corpus[1].properties.qualityloop, partOriginal: 'P-4471-A' }));
  const result = await handler.loadEvidence({ context });
  expect(result.strong.map(({ id }) => id)).toEqual(['101']);
  expect(result.relatedRevision.map(({ id }) => id)).toEqual(['100']);
  expect(result.pairs).toHaveProperty('100');
  expect(result.pairs).toHaveProperty('101');
  expect(result).toMatchObject({ notShown: { strong: 0, relatedRevision: 0 }, uncheckedCandidates: false });
});

test.each(['strong', 'relatedRevision'])('SIMULATED reclassification into %s retains the newest 25 without duplicate reads', async (destination) => {
  corpus = Array.from({ length: 60 }, (_, i) => issue(100 + i, { ...nc, recordType: 'CAPA',
    partOriginal: i < 30 ? 'P-4471-A' : 'P-4471-B', closedDate: '2026-10-01' }));
  const sourceRows = corpus.slice(destination === 'strong' ? 30 : 0, destination === 'strong' ? 60 : 30);
  for (const row of sourceRows) changed.set(row.id, issue(row.id, { ...row.properties.qualityloop,
    partOriginal: destination === 'strong' ? 'P-4471-A' : 'P-4471-B', closedDate: '2026-10-30' }));
  const authorised = new Map();
  const undisplayed = new Set();
  const result = await findMatches('1', loadBudget(), authorised, undisplayed);
  expect(result[destination]).toHaveLength(25);
  expect(result[destination].every(({ closedDate }) => closedDate === '2026-10-30')).toBe(true);
  expect(result[destination].map(({ id }) => id)).toEqual(sourceRows.slice(0, 25).map(({ id }) => id));
  expect(result[destination === 'strong' ? 'relatedRevision' : 'strong']).toEqual([]);
  expect(authorised.size).toBe(25);
  // Only unread snapshot candidates count as unchecked, never completed moves.
  expect(result.notShown).toEqual(destination === 'strong' ? { strong: 5, relatedRevision: 0 } : { strong: 0, relatedRevision: 30 });
  expect(result.verifiedNotShown[destination]).toBe(destination === 'strong' ? 30 : 5);
  expect(result.uncheckedCandidates).toBe(true);
  const directIds = requestJira.mock.calls.map(([path]) => path.match(/issue\/(\d+)\?/)?.[1]).filter(Boolean);
  expect(new Set(directIds).size).toBe(directIds.length);
  expect(sourceRows.slice(25).every(({ id }) => undisplayed.has(id))).toBe(true);
});

test('SIMULATED a signature re-read can move to other related', async () => {
  seed(5);
  changed.set('100', issue(100, { ...corpus[0].properties.qualityloop, failureMode: 'FM-02' }));
  const result = await handler.loadEvidence({ context });
  expect(result.strong.some(({ id }) => id === '100')).toBe(false);
  expect(result.otherRelated.some(({ id }) => id === '100')).toBe(true);
});

test.each(['strong', 'relatedRevision'])('SIMULATED other-related query candidate moves to fresh %s with decision state', async (destination) => {
  seed(5);
  changed.set('102', issue(102, { ...corpus[2].properties.qualityloop, failureMode: 'FM-01',
    partOriginal: destination === 'strong' ? 'P-4471-A' : 'P-4471-B' }));
  const result = await handler.loadEvidence({ context });
  expect(result[destination].some(({ id }) => id === '102')).toBe(true);
  expect(result.otherRelated.some(({ id }) => id === '102')).toBe(false);
  expect(result.pairs).toHaveProperty('102');
  expect(requestJira.mock.calls.filter(([path]) => path.includes('/issue/102?'))).toHaveLength(1);
  expect(result).toMatchObject({ uncheckedCandidates: false, verifiedNotShown: { strong: 0, relatedRevision: 0 } });
});

test.each([['strong', 0], ['strong', 5], ['relatedRevision', 0], ['relatedRevision', 5]])(
  'SIMULATED fresh %s into a full class with %i unchecked counts verified omissions separately', async (destination, unread) => {
  const signatureCount = 25 + unread;
  const movedId = String(100 + signatureCount);
  corpus = Array.from({ length: signatureCount }, (_, i) => issue(100 + i, { ...nc, recordType: 'CAPA',
    partOriginal: destination === 'strong' ? 'P-4471-A' : 'P-4471-B', closedDate: '2026-10-20' }));
  // The other-related query's fresh match is older than the 25 already
  // verified. Verified omissions alone must also mark the results incomplete.
  corpus.push(issue(movedId, { ...nc, recordType: 'CAPA', failureMode: 'FM-02', closedDate: '2026-10-01' }));
  changed.set(movedId, issue(movedId, { ...corpus[0].properties.qualityloop, closedDate: '2026-10-01' }));
  const authorised = new Map(), undisplayed = new Set();
  const result = await findMatches('1', loadBudget(), authorised, undisplayed);
  expect(result[destination]).toHaveLength(25);
  expect(result[destination].some(({ id }) => id === movedId)).toBe(false);
  expect(result.notShown[destination]).toBe(unread);
  expect(result.verifiedNotShown[destination]).toBe(1);
  expect(result.uncheckedCandidates).toBe(true);
  expect(undisplayed.has(movedId)).toBe(true);
  expect(authorised.has(movedId)).toBe(false);
  expect(requestJira.mock.calls.filter(([path]) => path.includes(`/issue/${movedId}?`))).toHaveLength(1);
});

test('SIMULATED cards use the fresh Jira status category while matching on recorded closure', async () => {
  seed(5);
  for (const id of ['100', '101']) {
    const row = corpus.find((item) => item.id === id);
    changed.set(id, { ...row, fields: { ...row.fields, status: { name: 'Backlog', statusCategory: { key: 'new' } } } });
  }
  const result = await handler.loadEvidence({ context });
  expect(result.strong[0]).toMatchObject({ id: '100', status: 'Backlog', statusCategory: 'new', closedDate: '2026-10-01' });
  expect(result.relatedRevision[0]).toMatchObject({ id: '101', status: 'Backlog', statusCategory: 'new', closedDate: '2026-10-01' });
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
    if (args[0].includes('/issue/125?')) clock = 15001;
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

test.each(['strong', 'relatedRevision'])('SIMULATED %s refills from the 26th candidate after 25 changed or denied reads', async (kind) => {
  corpus = Array.from({ length: 26 }, (_, i) => issue(100 + i, { ...nc, recordType: 'CAPA',
    partOriginal: kind === 'strong' ? 'P-4471-A' : 'P-4471-B',
    closedDate: `2026-10-${String(30 - i).padStart(2, '0')}` }));
  for (let i = 0; i < 25; i++) {
    if (i % 3 === 0) changed.set(String(100 + i), issue(100 + i, { ...corpus[i].properties.qualityloop, closedDate: null }));
    else hidden.set(String(100 + i), i % 3 === 1 ? 403 : 404);
  }
  corpus.reverse(); // search order must not determine the cutoff
  let active = 0;
  let maximum = 0;
  const read = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (...args) => {
    if (!/issue\/\d+\?/.test(args[0])) return read(...args);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    try { return await read(...args); } finally { active--; }
  });
  const result = await handler.loadEvidence({ context });
  expect(result[kind].map(({ id }) => id)).toEqual(['125']);
  expect(result).toMatchObject({ notShown: { strong: 0, relatedRevision: 0 }, uncheckedCandidates: false, incomplete: false });
  expect(maximum).toBe(5);
  const directIds = requestJira.mock.calls.map(([path]) => path.match(/issue\/(\d+)\?/)?.[1]).filter((id) => id && id !== '1');
  expect(directIds).toHaveLength(26);
  expect(new Set(directIds).size).toBe(26);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

test.each(['strong', 'relatedRevision'])('SIMULATED %s counts only unchecked snapshot candidates after refill, ignoring totals and permission races', async (kind) => {
  corpus = Array.from({ length: 60 }, (_, i) => issue(100 + i, { ...nc, recordType: 'CAPA',
    partOriginal: kind === 'strong' ? 'P-4471-A' : 'P-4471-B',
    closedDate: new Date(Date.UTC(2026, 9, 30 - i)).toISOString().slice(0, 10) }));
  // Five newest revoked records are re-read and excluded. The 30 un-read older
  // candidates also lose access after search; their validity is never claimed.
  for (let i = 0; i < 60; i++) if (i < 5 || i >= 30) hidden.set(String(100 + i), 403);
  const read = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (...args) => {
    const result = await read(...args);
    if (args[0] === '/rest/api/3/search/jql') {
      const data = await result.json();
      return response(200, { ...data, total: 987654 });
    }
    return result;
  });
  const result = await handler.loadEvidence({ context });
  expect(result[kind]).toHaveLength(25);
  expect(result[kind][0].id).toBe('105');
  expect(result[kind].at(-1).id).toBe('129');
  expect(result.notShown[kind]).toBe(30);
  expect(result.uncheckedCandidates).toBe(true);
  const directIds = requestJira.mock.calls.map(([path]) => path.match(/issue\/(\d+)\?/)?.[1]).filter((id) => id && id !== '1');
  expect(directIds).toHaveLength(30);
  expect(directIds).not.toContain('130');
  expect(JSON.stringify(result)).not.toMatch(/SECRET|987654|total/);
});

test('SIMULATED budget expiry before re-reads reports all collected candidates as unchecked', async () => {
  seed(500);
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  const read = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (...args) => {
    const result = await read(...args);
    if (args[0] === '/rest/api/3/search/jql' && JSON.parse(args[1].body).nextPageToken === '50') clock = 15001;
    return result;
  });
  const result = await findMatches('1', loadBudget());
  expect(result).toMatchObject({ incomplete: true, uncheckedCandidates: true, strong: [], relatedRevision: [] });
  expect(result.notShown.strong + result.notShown.relatedRevision).toBe(50);
});
