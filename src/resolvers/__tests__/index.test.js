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
jest.mock('../../config/devFlags', () => ({ E1_PROBE: true }));

// Explicit require keeps mocks registered before module evaluation with esbuild.
const api = require('@forge/api').default;
const { handler } = require('../index');

const requestJira = jest.fn();
const context = { extension: { issue: { id: '10001' } } };
const payload = { recordType: 'NC', partNumber: ' p-4471 -a ', failureMode: 'FM-01', detectedDate: '2026-10-31' };
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

beforeEach(() => {
  jest.clearAllMocks();
  api.asUser.mockReturnValue({ requestJira });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('saves only to the context issue and produces the complete property via asUser', async () => {
  requestJira.mockResolvedValue(response(201));
  const result = await handler.saveCapture({ context, payload });
  expect(requestJira).toHaveBeenCalledTimes(1);
  const [path, options] = requestJira.mock.calls[0];
  expect(path).toBe('/rest/api/3/issue/10001/properties/qualityloop');
  expect(options.method).toBe('PUT');
  const value = JSON.parse(options.body);
  expect(value).toEqual(result.record);
  expect(value).toMatchObject({ partOriginal: payload.partNumber, partNorm: 'P-4471 -A', schemaVersion: 1 });
  expect(Object.keys(value).sort()).toEqual([
    'schemaVersion', 'recordType', 'partOriginal', 'partNorm', 'partBase', 'partRevision',
    'failureMode', 'supplier', 'line', 'detectedDate', 'closedDate', 'effectivenessEvidenceUrl', 'updatedAt',
  ].sort());
  expect(api.asUser).toHaveBeenCalledTimes(1);
});

test('rejects payload issue identifiers before any API call', async () => {
  expect(await handler.saveCapture({ context, payload: { ...payload, issueId: '99999' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test('rejects missing context and invalid capture fields before any API call', async () => {
  expect(await handler.saveCapture({ context: {}, payload })).toHaveProperty('error');
  expect(await handler.saveCapture({ context, payload: { ...payload, partNumber: ' ' } })).toHaveProperty('fieldErrors.partNumber');
  expect(requestJira).not.toHaveBeenCalled();
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

test('returns errors as data on Jira failure without exposing response bodies', async () => {
  requestJira.mockResolvedValue(response(500, { secret: 'hidden' }));
  expect(await handler.loadCapture({ context })).toHaveProperty('error');
});

const token = 'E1-1793400000000-1';
test('probe writes a separate property and verifies the readback token', async () => {
  requestJira.mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(200, { value: { token } }));
  expect(await handler.probeWrite({ context, payload: { token } })).toEqual({ writeMs: expect.any(Number) });
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/issue/10001/properties/qualityloop-probe');
  expect(JSON.parse(requestJira.mock.calls[0][1].body)).toEqual({ token });
  expect(await handler.probeRead({ context, payload: { token } })).toEqual({ readbackOk: true });
  requestJira.mockResolvedValueOnce(response(200, { value: { token: 'different' } }));
  expect(await handler.probeRead({ context, payload: { token } })).toEqual({ readbackOk: false });
});

test('enhanced search is bounded to the context issue and requests only its id', async () => {
  requestJira.mockResolvedValue(response(200, { issues: [{ id: '10001' }] }));
  expect(await handler.probeSearch({ context, payload: { token } })).toEqual({ hit: true });
  expect(requestJira.mock.calls[0][0]).toBe('/rest/api/3/search/jql');
  expect(JSON.parse(requestJira.mock.calls[0][1].body)).toEqual({
    jql: `qlProbeToken = "${token}" AND issue = 10001`, maxResults: 1, fields: ['id'],
  });
  requestJira.mockResolvedValue(response(200, { issues: [{ id: '99999' }] }));
  expect(await handler.probeSearch({ context, payload: { token } })).toEqual({ hit: false });
});

test('rejects JQL injection and returns nothing for denied search', async () => {
  expect(await handler.probeSearch({ context, payload: { token: '" OR issue != 1' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
  requestJira.mockResolvedValue(response(403));
  expect(await handler.probeSearch({ context, payload: { token } })).toBeNull();
});

test('server gates every probe when the flag is false', async () => {
  jest.resetModules();
  jest.doMock('../../config/devFlags', () => ({ E1_PROBE: false }));
  const disabled = require('../index').handler;
  for (const name of ['probeWrite', 'probeRead', 'probeSearch']) {
    expect(await disabled[name]({ context, payload: { token } })).toEqual({ error: 'E1 probe is disabled.' });
  }
  expect(requestJira).not.toHaveBeenCalled();
});
