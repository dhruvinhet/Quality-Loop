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
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn() } }));

// Explicit require keeps mocks registered before module evaluation with esbuild.
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const { handler } = require('../index');

const requestJira = jest.fn();
const context = { extension: { issue: { id: '10001' } } };
const payload = { recordType: 'NC', partNumber: ' p-4471 -a ', failureMode: 'FM-01', detectedDate: '2026-10-31' };
// Model the issue's real project for scoped searches; property reads still use value.
const response = (status, value) => {
  const withProject = (issue) => issue?.properties?.qualityloop ? { ...issue, fields: { project: { id: '123', key: 'QL' }, ...issue.fields } } : issue;
  const body = value && Object.hasOwn(value, 'value')
    ? { ...value, fields: { project: { id: '123', key: 'QL' } }, properties: { qualityloop: value.value } } : withProject(value);
  if (body?.issues) body.issues = body.issues.map(withProject);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

beforeEach(() => {
  jest.clearAllMocks();
  kvs.get.mockReset().mockResolvedValue(undefined);
  requestJira.mockReset();
  requestJira.mockResolvedValue(response(200, { issues: [], isLast: true }));
  api.asUser.mockReturnValue({ requestJira });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('getFailureModes returns the seed when KVS is missing and reauthorises the context issue asUser', async () => {
  const result = await handler.getFailureModes({ context });
  expect(result.modes.find((m) => m.code === 'FM-07').label).toBe('Surface damage');
  expect(requestJira).toHaveBeenCalledWith('/rest/api/3/issue/10001?fields=id', expect.any(Object));
  expect(kvs.get).toHaveBeenCalledTimes(1);
});

test('an existing unsorted catalogue is returned by code without changing stored entries', async () => {
  const catalogue = { version: 7, modes: [{ code: 'FM-99', label: 'Other', active: true },
    { code: 'FM-08', label: 'Wire fracture', active: false }, { code: 'FM-01', label: 'Crack', active: true }] };
  kvs.get.mockResolvedValue(catalogue);
  const result = await handler.getFailureModes({ context });
  expect(result.modes.map((m) => m.code)).toEqual(['FM-01', 'FM-08', 'FM-99']);
  expect(catalogue.modes[0].code).toBe('FM-99');
  expect(result.version).toBe(7);
});

test('new schema-v3 custom codes produce a verified strong match through the resolver', async () => {
  const { buildCapture } = require('../../lib/capture');
  const current = buildCapture({ ...payload, failureMode: 'fm-08' });
  const candidate = { id: '20002', key: 'QL-2', fields: { summary: 'Custom wire fracture', status: { name: 'Done' } },
    properties: { qualityloop: buildCapture({ ...payload, recordType: 'CAPA', failureMode: 'FM-08', closedDate: '2026-10-01' }) } };
  requestJira.mockResolvedValueOnce(response(200, { value: current }))
    .mockResolvedValueOnce(response(200, { issues: [candidate], isLast: true }))
    .mockResolvedValueOnce(response(200, candidate))
    .mockResolvedValueOnce(response(200, { issues: [], isLast: true }));
  const result = await handler.findMatches({ context });
  expect(result.strong).toEqual([expect.objectContaining({ id: '20002', failureMode: 'FM-08' })]);
  expect(JSON.parse(requestJira.mock.calls[1][1].body).jql).toContain('qlFailureMode = "FM-08"');
});

test('the default sample scope ignores an identical DEMO CAPA in a different project, including after a move', async () => {
  const definitions = require('../../lib/sampleScenario').sampleDefinitions('2026-11-14');
  const current = definitions.at(-1).capture;
  const capa = definitions[1].capture;
  const local = { id: '20001', key: 'QA-2', fields: { project: { id: '123' }, summary: 'Local DEMO CAPA' }, properties: { qualityloop: capa } };
  const other = { ...local, id: '20002', key: 'OTHER-2', fields: { project: { id: '456' }, summary: 'Outside-scope DEMO CAPA' } };
  let moved = false;
  requestJira.mockImplementation(async (path) => {
    if (path.includes('/issue/10001?')) return response(200, { fields: { project: { id: '123' } }, properties: { qualityloop: current } });
    if (path === '/rest/api/3/search/jql') return response(200, { issues: [local, other], isLast: true });
    return response(200, moved ? { ...local, fields: { ...local.fields, project: { id: '456' } } } : local);
  });
  const first = await handler.findMatches({ context });
  expect(first.strong.map((match) => match.id)).toEqual(['20001']);
  expect(first.search).toMatchObject({ scope: 'PROJECT', lookbackDays: 365 });
  expect(JSON.stringify(first)).not.toContain('Outside-scope');
  expect(requestJira.mock.calls.some(([path]) => path.includes('/issue/20002?'))).toBe(false);
  moved = true;
  expect((await handler.findMatches({ context })).strong).toEqual([]);
});

test.each([['PROJECT', 365, 0], ['PROJECT', 730, 1], ['ALL', 730, 2]])(
  'NC project settings scope=%s window=%i apply to JQL, direct classification and hints', async (scope, lookbackDays, expected) => {
    kvs.get.mockImplementation(async (key) => key === 'settings:123'
      ? { version: 1, scope, lookbackDays, projectIds: [] } : undefined);
    const current = { schemaVersion: 3, recordType: 'NC', partOriginal: 'DEMO-5520-A', failureMode: 'FM-07', detectedDate: '2026-11-14' };
    const closedDate = new Date(Date.parse(current.detectedDate) - 400 * 86400000).toISOString().slice(0, 10);
    const rows = ['123', '456'].map((id) => ({ id: `20${id}`, key: `QA-${id}`, fields: { project: { id } },
      properties: { qualityloop: { ...current, recordType: 'CAPA', closedDate } } }));
    requestJira.mockImplementation(async (path) => {
      if (path.includes('/issue/10001?')) return response(200, { fields: { project: { id: '123' } }, properties: { qualityloop: current } });
      if (path === '/rest/api/3/search/jql') return response(200, { issues: rows, isLast: true });
      return response(200, rows.find((row) => path.includes(`/issue/${row.id}?`)));
    });
    const matches = await handler.findMatches({ context });
    expect(matches.strong).toHaveLength(expected);
    expect(matches.search).toMatchObject({ scope, lookbackDays });
    expect(kvs.get).toHaveBeenCalledWith('settings:123');
    expect(kvs.get).not.toHaveBeenCalledWith('settings:456');
    const jql = JSON.parse(requestJira.mock.calls.find(([path]) => path === '/rest/api/3/search/jql')[1].body).jql;
    expect(jql.includes('project in ("123")')).toBe(scope === 'PROJECT');
    const hints = await handler.findHints({ context });
    expect(hints.search.lookbackDays).toBe(lookbackDays);
    expect(hints.hints).toHaveLength(lookbackDays === 365 ? 1 : 0);
  });

test.each([403, 404])('catalogue read hides all metadata when issue access returns %s', async (status) => {
  requestJira.mockResolvedValue(response(status, {}));
  expect(await handler.getFailureModes({ context })).toBeNull();
  expect(kvs.get).not.toHaveBeenCalled();
});

test('direct save accepts active custom codes and rejects deactivated codes after a single authoritative read', async () => {
  const modes = [{ code: 'FM-08', label: 'Wire fracture', active: true }];
  kvs.get.mockResolvedValue({ version: 1, modes });
  requestJira.mockResolvedValueOnce(response(200, { properties: {} })).mockResolvedValueOnce(response(204));
  expect(await handler.saveCapture({ context, payload: { ...payload, failureMode: ' fm-08 ' } })).toHaveProperty('record.failureMode', 'FM-08');
  expect(kvs.get).toHaveBeenCalledTimes(1);
  kvs.get.mockResolvedValue({ version: 2, modes: [{ ...modes[0], active: false }] });
  requestJira.mockResolvedValue(response(200, { properties: {} }));
  expect(await handler.saveCapture({ context, payload: { ...payload, failureMode: 'FM-08' } })).toHaveProperty('fieldErrors.failureMode');
});

test.each([
  [' fm-08 ', 'FM-08', true],
  [undefined, 'FM-08', false],
  ['FM-08', 'FM-09', false],
  ['FM-10', 'FM-08', false],
  ['FM-08', 'FM-10', true],
  ['FM-08', ' fm-08 ', true],
  ['FM-77', 'FM-77', true],
])('save authorises the stored code only: stored=%j requested=%j succeeds=%s', async (storedCode, selectedCode, succeeds) => {
  kvs.get.mockResolvedValue({ version: 1, modes: [
    { code: 'FM-08', label: 'Wire fracture', active: false },
    { code: 'FM-09', label: 'Other old mode', active: false },
    { code: 'FM-10', label: 'Current mode', active: true },
  ] });
  const stored = storedCode ? { schemaVersion: 3, recordType: 'CAPA', failureMode: storedCode } : undefined;
  requestJira.mockResolvedValueOnce(response(200, { properties: { qualityloop: stored } }))
    .mockResolvedValueOnce(response(204));
  const result = await handler.saveCapture({ context, payload: { ...payload, recordType: 'CAPA', failureMode: selectedCode,
    closedDate: '2026-10-01', rootCause: 'Updated root cause only' } });
  if (succeeds) {
    expect(result.record).toMatchObject({ failureMode: selectedCode.trim().toUpperCase(), rootCause: 'Updated root cause only' });
    expect(requestJira.mock.calls[1][1].method).toBe('PUT');
    expect(api.asUser).toHaveBeenCalledTimes(2);
  } else {
    expect(result).toHaveProperty('fieldErrors.failureMode');
    expect(requestJira).toHaveBeenCalledTimes(1);
  }
});

test('a payload cannot supply the stored failure-mode exception', async () => {
  expect(await handler.saveCapture({ context, payload: { ...payload, storedFailureMode: 'FM-08' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test('deactivated schema-v3 records still load, and KVS failure/corruption never silently uses the seed', async () => {
  const record = { schemaVersion: 3, recordType: 'CAPA', failureMode: 'FM-08' };
  requestJira.mockResolvedValue(response(200, { value: record }));
  expect(await handler.loadCapture({ context })).toEqual({ record });
  for (const corrupt of [null, { version: 1, modes: [null] }]) {
    kvs.get.mockResolvedValue(corrupt);
    expect(await handler.getFailureModes({ context })).toHaveProperty('error');
  }
  kvs.get.mockRejectedValue(new Error('Unavailable'));
  expect(await handler.getFailureModes({ context })).toHaveProperty('error');
});

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
  expect(value).toMatchObject({ partOriginal: payload.partNumber, partNorm: 'P-4471-A', partBase: 'P-4471', schemaVersion: 3 });
  expect(Object.keys(value).sort()).toEqual([
    'schemaVersion', 'recordType', 'partOriginal', 'partNorm', 'partBase', 'partRevision',
    'failureMode', 'supplier', 'supplierNorm', 'line', 'lineNorm', 'detectedDate', 'closedDate', 'effectivenessEvidenceUrl', 'rootCause', 'actionsTaken', 'updatedAt',
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

test('save rejects a legacy HTTP CAPA edit without dropping or rewriting the stored link', async () => {
  const record = Object.freeze({ schemaVersion: 2, recordType: 'CAPA', closedDate: '2026-10-01',
    effectivenessEvidenceUrl: 'http://example.com/legacy-report' });
  requestJira.mockResolvedValue(response(200, { properties: { qualityloop: record } }));
  expect(await handler.saveCapture({ context, payload: { ...payload, recordType: 'CAPA', closedDate: record.closedDate,
    effectivenessEvidenceUrl: record.effectivenessEvidenceUrl } })).toEqual({ fieldErrors: { effectivenessEvidenceUrl: 'Use an https:// link.' } });
  expect(requestJira).toHaveBeenCalledTimes(1);
  expect(requestJira.mock.calls.some(([, options]) => options.method === 'PUT')).toBe(false);
  expect(record.effectivenessEvidenceUrl).toBe('http://example.com/legacy-report');
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
    'loadCapture', 'loadEvidence', 'saveCapture', 'findMatches', 'findHints', 'getPanelAccess', 'getFailureModes',
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
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/10001?fields=project&properties=qualityloop');
  const [path, options] = requestJira.mock.calls[1];
  expect(path).toBe('/rest/api/3/search/jql');
  expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toMatchObject({ maxResults: 50, fields: ['summary', 'status', 'project'], properties: ['qualityloop'] });
  expect(requestJira.mock.calls[2][0]).toBe('/rest/api/3/issue/20002?fields=summary,status,project&properties=qualityloop');
  expect(api.asUser).toHaveBeenCalledTimes(5);
});

test.each([403, 404])('re-fetch denial (%s) drops candidate without counts or stale data', async (status) => {
  requestJira.mockResolvedValueOnce(response(200, { value: matchingNc }))
    .mockResolvedValueOnce(response(200, { issues: [{ id: '20002', summary: 'Secret', properties: { qualityloop: matchingCapa } }] }))
    .mockResolvedValueOnce(response(status, { secret: 'hidden' }));
  const result = await handler.findMatches({ context });
  expect(result).toEqual({ applicable: true, strong: [], relatedRevision: [], otherRelated: [], matchesIncomplete: false, otherRelatedIncomplete: false, incomplete: false, uncheckedCandidates: false, notShown: { strong: 0, relatedRevision: 0 }, verifiedNotShown: { strong: 0, relatedRevision: 0 }, supplierIndexLimited: true, search: { scope: 'PROJECT', scopeLabel: 'this project only', lookbackDays: 365 }, elapsedMs: expect.any(Number) });
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
    if (path.endsWith('/properties/qualityloop') || path.includes('?fields=project&properties=qualityloop')) return response(200, { value: matchingNc });
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
  expect(Object.keys(result)).toEqual(['applicable', 'search', 'incomplete', 'truncated', 'hints']);
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
    if (path.endsWith('/properties/qualityloop') || path.includes('?fields=project&properties=qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: [{ id: '20002', key: 'SECRET', properties: { qualityloop: matchingCapa } }], total: 42,
    });
    return { status, ok: false, json };
  });
  expect(await handler.findHints({ context })).toEqual({ applicable: true, search: { scope: 'PROJECT', scopeLabel: 'this project only', lookbackDays: 365 }, hints: [] });
  expect(json).not.toHaveBeenCalled();
});

test('findHints rechecks stored values instead of hinting from stale search data', async () => {
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop') || path.includes('?fields=project&properties=qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: [{ id: '20002', properties: { qualityloop: { ...matchingCapa, closedDate: null } } }],
    });
    return response(200, freshIssue()); // now a strong match, never a hint
  });
  expect(await handler.findHints({ context })).toEqual({ applicable: true, search: { scope: 'PROJECT', scopeLabel: 'this project only', lookbackDays: 365 }, hints: [] });
});

test('findHints enforces each search cap even on oversized pages and ignores continuation tokens', async () => {
  requestJira.mockImplementation(async (path) => {
    if (path.endsWith('/properties/qualityloop') || path.includes('?fields=project&properties=qualityloop')) return response(200, { value: matchingNc });
    if (path === '/rest/api/3/search/jql') return response(200, {
      issues: Array.from({ length: 60 }, (_, index) => ({ id: String(20000 + index) })), nextPageToken: 'ignored',
    });
    const id = path.match(/issue\/(\d+)\?/)[1];
    return response(200, freshIssue(id, { ...matchingCapa, closedDate: null }));
  });
  expect((await handler.findHints({ context })).hints).toHaveLength(3);
  expect(requestJira.mock.calls.filter(([path]) => path.includes('?fields=summary,status,project'))).toHaveLength(50);
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
    if (path.endsWith('/properties/qualityloop') || path.includes('?fields=project&properties=qualityloop')) return response(200, { value: matchingNc });
    return response(200, { issues: [], ...continuation });
  });
  expect(await handler.findHints({ context })).toEqual({ applicable: true, search: { scope: 'PROJECT', scopeLabel: 'this project only', lookbackDays: 365 }, incomplete: true, truncated: true, hints: [] });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/search/jql')).toHaveLength(3);
  expect(requestJira.mock.calls.some(([, options]) => options?.body && JSON.parse(options.body).nextPageToken)).toBe(false);
});
