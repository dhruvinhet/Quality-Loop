jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.mock('../../config/devFlags', () => ({ SEC_TEST: true, E1_PROBE: false }));

const api = require('@forge/api').default;
const flags = require('../../config/devFlags');
const { handler } = require('../index');
const { buildMatchJql } = require('../../lib/matchJql');
const { JQL_SECURITY_PARTS, securityCapturePayload } = require('../../lib/securitySelfTest');
const requestJira = jest.fn();
const context = { extension: { issue: { id: '10001' } } };
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: jest.fn(async () => value) });
const previous = { schemaVersion: 1, recordType: 'NC', partOriginal: ' p-1-a ', failureMode: 'FM-01', detectedDate: '2026-10-31', updatedAt: 'original', unknownField: { retained: true } };
const savePayload = { ...securityCapturePayload(null), securityTest: true };

beforeEach(() => {
  jest.clearAllMocks();
  requestJira.mockReset();
  flags.SEC_TEST = true;
  api.asUser.mockReturnValue({ requestJira });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test.each([403, 404])('direct read exposes only denial status (%s), without parsing the body', async (status) => {
  const denied = response(status, { fields: { summary: 'SECRET' } });
  requestJira.mockResolvedValue(denied);
  expect(await handler.probeIssueAccess({ context, payload: { issueIdOrKey: 'HIDDEN-1' } })).toEqual({ status, hasSummary: false });
  expect(denied.json).not.toHaveBeenCalled();
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/HIDDEN-1?fields=summary');
});

test('readable direct probe returns a boolean without summary text, IDs or counts', async () => {
  requestJira.mockResolvedValue(response(200, { id: '22222', fields: { summary: 'SECRET' } }));
  expect(await handler.probeIssueAccess({ context, payload: { issueIdOrKey: '22222' } })).toEqual({ status: 200, hasSummary: true });
});

test.each(['../123', 'QL-1?fields=*all', '', 123])('rejects invalid probe identifiers: %s', async (issueIdOrKey) => {
  expect(await handler.probeIssueAccess({ context, payload: { issueIdOrKey } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test('injected capture-read ID is ignored and returned source ID comes from resolver context', async () => {
  requestJira.mockResolvedValue(response(200, { value: previous }));
  expect(await handler.loadCapture({ context, payload: { securityTest: true, issueId: '99999' } }))
    .toEqual({ record: previous, securityTest: { issueId: '10001', http: [{ operation: 'property GET', status: 200 }] } });
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/10001/properties/qualityloop');
});

test('injected match ID is ignored through the real JQL builder and candidates are still reauthorised', async () => {
  requestJira.mockResolvedValueOnce(response(200, { value: previous }))
    .mockResolvedValueOnce(response(200, { issues: [{ id: '20002' }] }))
    .mockResolvedValueOnce(response(403, { fields: { summary: 'SECRET' } }));
  const result = await handler.findMatches({ context, payload: { securityTest: true, issueId: '99999' } });
  expect(result.securityTest.issueId).toBe('10001');
  expect(result.strong).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|99999/);
  expect(JSON.parse(requestJira.mock.calls[1][1].body).jql).toBe(buildMatchJql(previous));
  expect(requestJira.mock.calls.map(([path]) => path)).toEqual([
    '/rest/api/3/issue/10001/properties/qualityloop', '/rest/api/3/search/jql',
    '/rest/api/3/issue/20002?fields=summary,status&properties=qualityloop',
  ]);
});

test.each(['loadCapture', 'findMatches'])('denied dev %s returns no data or source IDs', async (name) => {
  requestJira.mockResolvedValue(response(403, { value: previous }));
  expect(await handler[name]({ context, payload: { securityTest: true, issueId: '99999' } })).toBeNull();
});

test('JQL probe uses all three real builder inputs and returns statuses only', async () => {
  requestJira.mockResolvedValue(response(200, { issues: [{ fields: { summary: 'SECRET' } }] }));
  expect(await handler.probeJqlEscaping({ context })).toEqual({ results: JQL_SECURITY_PARTS.map((partBase) => ({ partBase, status: 200 })) });
  for (let index = 0; index < 3; index += 1) {
    const [path, options] = requestJira.mock.calls[index];
    expect(path).toBe('/rest/api/3/search/jql');
    expect(JSON.parse(options.body)).toEqual({ jql: buildMatchJql({ partOriginal: JQL_SECURITY_PARTS[index], failureMode: 'FM-01', detectedDate: '2026-10-31' }), fields: ['id'], maxResults: 1 });
  }
  expect(api.asUser).toHaveBeenCalledTimes(3);
});

test('JQL probe reports a syntax failure and transport error without skipping subsequent fixtures', async () => {
  requestJira.mockResolvedValueOnce(response(400)).mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce(response(200));
  const { results } = await handler.probeJqlEscaping({ context });
  expect(results.map(({ status, error }) => error ?? status)).toEqual([400, 'network failed', 200]);
});

const snapshot = (value = previous) => requestJira.mockResolvedValueOnce(response(200, { fields: { summary: 'Current' } }))
  .mockResolvedValueOnce(response(value === null ? 404 : 200, { value }));

test('browse-only save hits the real PUT, reports raw 403 and makes no restoration write', async () => {
  snapshot().mockResolvedValueOnce(response(403));
  const { securityTest } = await handler.saveCapture({ context, payload: savePayload });
  expect(securityTest.http.at(-1)).toEqual({ operation: 'save PUT', status: 403 });
  expect(securityTest.restored).toBe(true);
  expect(requestJira).toHaveBeenCalledTimes(3);
  expect(JSON.parse(requestJira.mock.calls[2][1].body)).toMatchObject({ partOriginal: previous.partOriginal });
});

test('editor save restores the exact prior JSON including schema, timestamp and unknown fields', async () => {
  snapshot().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200, { value: previous }));
  const result = await handler.saveCapture({ context, payload: savePayload });
  expect(result.securityTest.restored).toBe(true);
  expect(result.securityTest.error).toBeUndefined();
  expect(JSON.parse(requestJira.mock.calls[3][1].body)).toEqual(previous);
  expect(requestJira.mock.calls.every(([path]) => path.startsWith('/rest/api/3/issue/10001'))).toBe(true);
});

test('absent property is removed again and absence verified after a successful create', async () => {
  snapshot(null).mockResolvedValueOnce(response(201)).mockResolvedValueOnce(response(204)).mockResolvedValueOnce(response(404));
  const result = await handler.saveCapture({ context, payload: savePayload });
  expect(result.securityTest.restored).toBe(true);
  expect(requestJira.mock.calls[3][1].method).toBe('DELETE');
});

test('failed restoration reports FAIL evidence instead of claiming success', async () => {
  snapshot().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(403));
  const result = await handler.saveCapture({ context, payload: savePayload });
  expect(result.securityTest).toMatchObject({ restored: false, error: 'Restore returned HTTP 403' });
});

test('transport failure after PUT still attempts restoration', async () => {
  snapshot().mockRejectedValueOnce(new Error('PUT connection lost')).mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200, { value: previous }));
  const result = await handler.saveCapture({ context, payload: savePayload });
  expect(result.securityTest).toMatchObject({ restored: true, error: 'PUT connection lost' });
  expect(JSON.parse(requestJira.mock.calls[3][1].body)).toEqual(previous);
});

test('server error after PUT attempts restoration and remains a failed write check', async () => {
  snapshot().mockResolvedValueOnce(response(500)).mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200, { value: previous }));
  const result = await handler.saveCapture({ context, payload: savePayload });
  expect(result.securityTest).toMatchObject({ restored: true, error: 'Property PUT returned HTTP 500' });
  expect(result.securityTest.http).toContainEqual({ operation: 'save PUT', status: 500 });
  expect(JSON.parse(requestJira.mock.calls[3][1].body)).toEqual(previous);
});

test('inaccessible current issue prevents snapshot or test write', async () => {
  requestJira.mockResolvedValue(response(404));
  const result = await handler.saveCapture({ context, payload: savePayload });
  expect(result.securityTest.http).toEqual([{ operation: 'current issue GET', status: 404 }]);
  expect(requestJira).toHaveBeenCalledTimes(1);
});

test('write payload IDs and missing resolver context are still rejected before any API request', async () => {
  expect(await handler.saveCapture({ context, payload: { ...savePayload, issueId: '99999' } })).toHaveProperty('error');
  expect(await handler.probeIssueAccess({ context: {}, payload: { issueIdOrKey: '99999' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test('disabled build refuses probes and dev modes while preserving production payload rejection', async () => {
  flags.SEC_TEST = false;
  for (const [name, payload] of [
    ['probeIssueAccess', { issueIdOrKey: '99999' }], ['probeJqlEscaping', {}],
    ['saveCapture', savePayload], ['loadCapture', { securityTest: true }], ['findMatches', { securityTest: true, issueId: '99999' }],
  ]) expect(await handler[name]({ context, payload })).toEqual({ error: 'Security self-test is disabled.' });
  expect(await handler.findMatches({ context, payload: { issueId: '99999' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});
