jest.mock('@forge/resolver', () => ({
  __esModule: true,
  default: class {
    definitions = {};
    define(name, fn) { this.definitions[name] = fn; }
    getDefinitions() { return this.definitions; }
  },
}));
jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asUser: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

// Explicit require keeps mocks registered before module evaluation with esbuild.
const api = require('@forge/api').default;
const { handler } = require('../index');

const requestJira = jest.fn();
const context = { extension: { issue: { id: '10001' } } };
const payload = { recordType: 'NC', partNumber: ' p-4471 -a ', failureMode: 'FM-01', detectedDate: '2026-10-31' };
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

beforeEach(() => {
  jest.clearAllMocks();
  requestJira.mockReset();
  requestJira.mockResolvedValue(response(200, { issues: [], isLast: true }));
  api.asUser.mockReturnValue({ requestJira });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('saves only to the context issue and produces the complete property via asUser', async () => {
  requestJira.mockResolvedValueOnce(response(200, { properties: {} })).mockResolvedValueOnce(response(201));
  const result = await handler.saveCapture({ context, payload });
  expect(requestJira).toHaveBeenCalledTimes(2);
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/10001?fields=summary&properties=qualityloop');
  const [path, options] = requestJira.mock.calls[1];
  expect(path).toBe('/rest/api/3/issue/10001/properties/qualityloop');
  expect(options.method).toBe('PUT');
  const value = JSON.parse(options.body);
  expect(value).toEqual(result.record);
  expect(value).toMatchObject({ partOriginal: payload.partNumber, partNorm: 'P-4471 -A', schemaVersion: 2 });
  expect(Object.keys(value).sort()).toEqual([
    'schemaVersion', 'recordType', 'partOriginal', 'partNorm', 'partBase', 'partRevision',
    'failureMode', 'supplier', 'line', 'detectedDate', 'closedDate', 'effectivenessEvidenceUrl', 'rootCause', 'actionsTaken', 'updatedAt',
  ].sort());
  expect(api.asUser).toHaveBeenCalledTimes(2);
});

test.each([['NC', 'CAPA'], ['CAPA', 'NC']])('direct saveCapture cannot convert an existing %s to %s', async (storedType, requestedType) => {
  requestJira.mockResolvedValue(response(200, { properties: { qualityloop: { schemaVersion: 2, recordType: storedType } } }));
  expect(await handler.saveCapture({ context, payload: { ...payload, recordType: requestedType, closedDate: '2026-10-01' } })).toEqual({
    error: 'Record type cannot be changed after the first save. Create a new issue instead.',
  });
  expect(requestJira).toHaveBeenCalledTimes(1);
  expect(api.asUser).toHaveBeenCalledTimes(1);
  expect(requestJira.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false);
});

test('existing NC can save edits without changing type', async () => {
  requestJira.mockResolvedValueOnce(response(200, { properties: { qualityloop: { schemaVersion: 2, recordType: 'NC' } } }))
    .mockResolvedValueOnce(response(200));
  expect(await handler.saveCapture({ context, payload })).toHaveProperty('record.recordType', 'NC');
  expect(requestJira).toHaveBeenCalledTimes(2);
});

test('a new CAPA cannot save without a closed date', async () => {
  requestJira.mockResolvedValue(response(200, { properties: {} }));
  expect(await handler.saveCapture({ context, payload: { ...payload, recordType: 'CAPA' } })).toEqual({
    fieldErrors: { closedDate: 'Select a closed date for a CAPA. Matching uses this date, not Jira status.' },
  });
  expect(requestJira).toHaveBeenCalledTimes(1);
  expect(requestJira.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false);
});

test('type-change rejection uses the exact error even when other CAPA fields are missing', async () => {
  requestJira.mockResolvedValue(response(200, { properties: { qualityloop: { recordType: 'NC' } } }));
  expect(await handler.saveCapture({ context, payload: { ...payload, recordType: 'CAPA' } })).toEqual({
    error: 'Record type cannot be changed after the first save. Create a new issue instead.',
  });
  expect(requestJira).toHaveBeenCalledTimes(1);
});

test.each([1, 2])('legacy schema %i CAPA without closure still loads and can save after entering the date', async (schemaVersion) => {
  const record = { schemaVersion, recordType: 'CAPA', partOriginal: payload.partNumber, closedDate: null };
  requestJira.mockResolvedValueOnce(response(200, { value: record }));
  expect(await handler.loadCapture({ context })).toEqual({ record });
  requestJira.mockResolvedValueOnce(response(200, { properties: { qualityloop: record } })).mockResolvedValueOnce(response(200));
  expect(await handler.saveCapture({ context, payload: { ...payload, recordType: 'CAPA', closedDate: '2026-10-01' } }))
    .toHaveProperty('record.closedDate', '2026-10-01');
});

test('failed type-check read never proceeds to a write or reveals response data', async () => {
  requestJira.mockResolvedValue(response(500, { secret: 'hidden' }));
  expect(await handler.saveCapture({ context, payload })).toEqual({ error: expect.any(String) });
  expect(requestJira).toHaveBeenCalledTimes(1);
});

test('rejects payload issue identifiers before any API call', async () => {
  expect(await handler.saveCapture({ context, payload: { ...payload, issueId: '99999' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test('rejects missing context before any API call and invalid capture fields before writing', async () => {
  expect(await handler.saveCapture({ context: {}, payload })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
  expect(await handler.saveCapture({ context, payload: { ...payload, partNumber: ' ' } })).toHaveProperty('fieldErrors.partNumber');
  expect(requestJira).toHaveBeenCalledTimes(1);
  expect(requestJira.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false);
});

test('loads the property asUser for form prefill', async () => {
  const record = { schemaVersion: 1, partOriginal: payload.partNumber };
  requestJira.mockResolvedValue(response(200, { key: 'qualityloop', value: record }));
  expect(await handler.loadCapture({ context })).toEqual({ record });
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/10001/properties/qualityloop');
});

test.each([403, 404])('returns nothing on denied/missing property operations (%s)', async (status) => {
  requestJira.mockResolvedValue(response(status, { value: { secret: 'hidden' } }));
  expect(await handler.loadCapture({ context })).toBeNull();
  expect(await handler.saveCapture({ context, payload })).toBeNull();
});

test.each([403, 404])('save returns nothing if write access is revoked after the type check (%s)', async (status) => {
  const json = jest.fn();
  requestJira.mockResolvedValueOnce(response(200, { properties: { qualityloop: { recordType: 'NC' } } }))
    .mockResolvedValueOnce({ status, ok: false, json });
  expect(await handler.saveCapture({ context, payload })).toBeNull();
  expect(requestJira).toHaveBeenCalledTimes(2);
  expect(json).not.toHaveBeenCalled();
});

test('returns errors as data on Jira failure without exposing response bodies', async () => {
  requestJira.mockResolvedValue(response(500, { secret: 'hidden' }));
  expect(await handler.loadCapture({ context })).toHaveProperty('error');
});

test('release resolver surface contains only shipped features', () => {
  expect(Object.keys(handler).sort()).toEqual([
    'loadCapture', 'loadEvidence', 'saveCapture', 'findMatches', 'findHints', 'getPanelAccess',
    'recordDecision', 'getDecisions', 'prepareConcernTask', 'createConcernTask', 'checkConcernTask', 'confirmConcernTask', 'prepareRepairLink', 'repairConcernLink',
  ].sort());
});

test.each(Object.keys(handler))('%s rejects injected issue IDs and self-test fields before any Jira call', async (name) => {
  for (const injected of [{ issueId: '99999' }, { securityTest: true }]) {
    expect(await handler[name]({ context, payload: injected })).toHaveProperty('error');
  }
  expect(requestJira).not.toHaveBeenCalled();
});

test.each(Object.keys(handler))('%s requires the current issue ID in resolver context', async (name) => {
  expect(await handler[name]({ context: {}, payload: {} })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test('exceptions never expose field values or stack traces in responses or logs', async () => {
  requestJira.mockRejectedValue(new Error('SECRET-1 narrative https://private/evidence'));
  const result = await handler.loadCapture({ context });
  expect(result).toEqual({ error: expect.any(String) });
  expect(JSON.stringify([result, console.error.mock.calls])).not.toMatch(/SECRET|narrative|private|stack/);
  expect(console.error).toHaveBeenCalledWith('QualityLoop loadCapture failed.');
});

const matchingNc = { schemaVersion: 1, recordType: 'NC', partOriginal: 'P-4471-A',
  failureMode: 'FM-01', supplier: 'Supplier 1', detectedDate: '2026-10-31' };
const matchingCapa = { ...matchingNc, recordType: 'CAPA', closedDate: '2026-10-01' };
const freshIssue = (id = '20002', capture = matchingCapa) => ({ id, key: `QL-${id}`,
  fields: { summary: 'Fresh summary', status: { name: 'Done' } }, properties: { qualityloop: capture } });

test.each([1, 2])('loads schema version %s', async (schemaVersion) => {
  const record = { ...matchingNc, schemaVersion };
  requestJira.mockResolvedValue(response(200, { value: record }));
  expect(await handler.loadCapture({ context })).toEqual({ record });
});

test('findMatches reads the context property, requests enhanced-search properties and re-fetches fresh evidence', async () => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc }))
    .mockResolvedValueOnce(response(200, { issues: [{ id: '20002', fields: { summary: 'Stale summary' },
      properties: { qualityloop: { ...matchingCapa, rootCause: 'Stale narrative' } } }], isLast: true }))
    .mockResolvedValueOnce(response(200, freshIssue()));
  const result = await handler.findMatches({ context });
  expect(result).toMatchObject({ applicable: true, elapsedMs: expect.any(Number),
    strong: [{ key: 'QL-20002', summary: 'Fresh summary', status: 'Done', rootCause: '', daysSinceClosure: 30 }] });
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/10001/properties/qualityloop');
  const [path, options] = requestJira.mock.calls[1];
  expect(path).toBe('/rest/api/3/search/jql');
  expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toMatchObject({ maxResults: 50, fields: ['summary', 'status'], properties: ['qualityloop'] });
  expect(requestJira.mock.calls[2][0]).toBe('/rest/api/3/issue/20002?fields=summary,status&properties=qualityloop');
  expect(api.asUser).toHaveBeenCalledTimes(5);
});

test.each([403, 404])('re-fetch denial (%s) drops candidate without counts or stale data', async (status) => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc }))
    .mockResolvedValueOnce(response(200, { issues: [{ id: '20002', summary: 'Secret', properties: { qualityloop: matchingCapa } }] }))
    .mockResolvedValueOnce(response(status, { secret: 'hidden' }));
  const result = await handler.findMatches({ context });
  expect(result).toEqual({ applicable: true, strong: [], relatedRevision: [], otherRelated: [], matchesIncomplete: false, otherRelatedIncomplete: false, incomplete: false, uncheckedCandidates: false, notShown: { strong: 0, relatedRevision: 0 }, verifiedNotShown: { strong: 0, relatedRevision: 0 }, elapsedMs: expect.any(Number) });
  expect(JSON.stringify(result)).not.toMatch(/Secret|hidden|count/i);
});

test('re-fetched property changes are reclassified rather than trusting search snapshots', async () => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc }))
    .mockResolvedValueOnce(response(200, { issues: [{ id: '20002', properties: { qualityloop: matchingCapa } }] }))
    .mockResolvedValueOnce(response(200, freshIssue('20002', { ...matchingCapa, closedDate: '2026-11-01' })));
  expect((await handler.findMatches({ context })).strong).toEqual([]);
});

test('follows nextPageToken before fresh reads and omits self and duplicates', async () => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc }))
    .mockResolvedValueOnce(response(200, { issues: [freshIssue('10001'), freshIssue('20002')], nextPageToken: 'next' }))
    .mockResolvedValueOnce(response(200, { issues: [freshIssue('20002'), freshIssue('20003')], isLast: true }))
    .mockResolvedValueOnce(response(200, freshIssue()))
    .mockResolvedValueOnce(response(200, freshIssue('20003')));
  const result = await handler.findMatches({ context });
  expect(result.strong.map(({ id }) => id)).toEqual(['20002', '20003']);
  expect(JSON.parse(requestJira.mock.calls[2][1].body)).toHaveProperty('nextPageToken', 'next');
  expect(requestJira).toHaveBeenCalledTimes(7);
});

test.each([{ ...matchingNc, recordType: 'CAPA' }, { ...matchingNc, detectedDate: null }])('nonapplicable capture does not search', async (record) => {
  requestJira.mockResolvedValue(response(200, { value: record }));
  expect(await handler.findMatches({ context })).toEqual({ applicable: false });
  expect(requestJira).toHaveBeenCalledTimes(1);
});

test('findMatches rejects payload identifiers and missing resolver context before reading', async () => {
  expect(await handler.findMatches({ context, payload: { issueId: '20002' } })).toHaveProperty('error');
  expect(await handler.findMatches({ context: {}, payload: {} })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test.each([403, 404])('own property or search denial (%s) returns nothing', async (status) => {
  requestJira.mockResolvedValueOnce(response(status));
  expect(await handler.findMatches({ context })).toBeNull();
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc })).mockResolvedValueOnce(response(status));
  expect(await handler.findMatches({ context })).toBeNull();
});

test('a candidate API error returns an error instead of an incomplete no-match result', async () => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc }))
    .mockResolvedValueOnce(response(200, { issues: [freshIssue()] }))
    .mockResolvedValueOnce(response(500, { secret: 'hidden' }));
  expect(await handler.findMatches({ context })).toEqual({ error: expect.any(String) });
});

test('findHints uses separate capped enhanced searches and freshly reauthorised records only', async () => {
  const captures = {
    '20002': { ...matchingCapa, partOriginal: 'P-4741-A' },
    '20003': { ...matchingCapa, closedDate: null },
    '20004': { ...matchingCapa, closedDate: '2025-10-30' },
  };
  let search = 0;
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: [{ id: '10001' }, { id: String(20002 + search++) }, { id: '20002' }],
      nextPageToken: 'must-not-follow', total: 999, fields: { summary: 'STALE' },
    });
    const id = path.match(/issue\/(\d+)\?/)[1];
    return response(200, freshIssue(id, captures[id]));
  });
  const result = await handler.findHints({ context });
  expect(result.hints.map(({ id, reason }) => [id, reason])).toEqual([
    ['20002', 'Part number differs slightly: stored "P-4741-A", this NC "P-4471-A"'],
    ['20003', 'No closed date recorded'],
    ['20004', 'Older precedent: closed 366 days before detection (outside the 365-day window)'],
  ]);
  expect(Object.keys(result)).toEqual(['applicable', 'incomplete', 'truncated', 'hints']);
  expect(result).toMatchObject({ incomplete: true, truncated: true });
  expect(result.hints.map(({ summary }) => summary)).toEqual([
    'Fresh summary', 'Fresh summary', 'Fresh summary',
  ]);
  expect(JSON.stringify(result)).not.toMatch(/STALE|999|total|count/i);
  const searches = requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/search/jql');
  expect(searches).toHaveLength(3);
  for (const [, options] of searches) {
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ jql: expect.any(String), maxResults: 50, fields: ['id'] });
  }
  expect(requestJira).toHaveBeenCalledTimes(7);
  expect(api.asUser).toHaveBeenCalledTimes(7);
});

test.each([403, 404])('findHints drops denied candidate %s without reading or leaking its body', async (status) => {
  const json = jest.fn();
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: [{ id: '20002', key: 'SECRET', properties: { qualityloop: matchingCapa } }], total: 42,
    });
    return { status, ok: false, json };
  });
  expect(await handler.findHints({ context })).toEqual({ applicable: true, hints: [] });
  expect(json).not.toHaveBeenCalled();
});

test('findHints rechecks stored values instead of hinting from stale search data', async () => {
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: [{ id: '20002', properties: { qualityloop: { ...matchingCapa, closedDate: null } } }],
    });
    return response(200, freshIssue()); // now a strong match, never a hint
  });
  expect(await handler.findHints({ context })).toEqual({ applicable: true, hints: [] });
});

test('findHints enforces each search cap even on oversized pages and ignores continuation tokens', async () => {
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: Array.from({ length: 60 }, (_, index) => ({ id: String(20000 + index) })), nextPageToken: 'ignored',
    });
    const id = path.match(/issue\/(\d+)\?/)[1];
    return response(200, freshIssue(id, { ...matchingCapa, closedDate: null }));
  });
  expect((await handler.findHints({ context })).hints).toHaveLength(3);
  expect(requestJira.mock.calls.filter(([path]) => path.includes('?fields='))).toHaveLength(50);
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/search/jql')).toHaveLength(3);
});

test('findHints rejects payload ids and missing context before accessing Jira', async () => {
  expect(await handler.findHints({ context, payload: { issueId: '99999' } })).toHaveProperty('error');
  expect(await handler.findHints({ context: {} })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test.each([403, 404])('findHints returns nothing on current-property or search denial %s', async (status) => {
  requestJira.mockResolvedValueOnce(response(status));
  expect(await handler.findHints({ context })).toBeNull();
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc })).mockResolvedValueOnce(response(status));
  expect(await handler.findHints({ context })).toBeNull();
});

test('hint search errors return an error, never a fabricated empty-hints success', async () => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc })).mockResolvedValueOnce(response(500));
  expect(await handler.findHints({ context })).toEqual({ error: expect.any(String) });
});

test.each([{ isLast: false }, { nextPageToken: 'more' }, { isLast: true, nextPageToken: 'more' }])('hint continuation %j marks the limited search incomplete and truncated', async (continuation) => {
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop')) return response(200, { value: matchingNc });
    return response(200, { issues: [], ...continuation });
  });
  expect(await handler.findHints({ context })).toEqual({ applicable: true, incomplete: true, truncated: true, hints: [] });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/search/jql')).toHaveLength(3);
  expect(requestJira.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).nextPageToken)).toBe(false);
});
