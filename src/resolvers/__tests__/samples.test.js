jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn(), asApp: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn(), set: jest.fn(), delete: jest.fn() } }));
jest.mock('../cleanupStore', () => ({ recordPage: jest.fn(), deleteRecordBatch: jest.fn() }));
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const { handler } = require('../samples');
const { recordPage, deleteRecordBatch } = require('../cleanupStore');
const { sampleDefinitions } = require('../../lib/sampleScenario');
const context = { accountId: 'creator', extension: { type: 'jira:projectPage', project: { id: '100' } } };
const project = { id: '100', key: 'QL', issueTypes: [{ id: '5', name: 'Task' }] };
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const sampleIssue = (id, labels = ['qualityloop-sample']) => ({ id, key: `QL-${id}`, fields: { labels, project: { id: '100' } } });
const requestJira = jest.fn();
let storage;
beforeEach(() => {
  jest.clearAllMocks();
  requestJira.mockReset();
  storage = new Map();
  api.asUser.mockReturnValue({ requestJira });
  kvs.get.mockImplementation(async (key) => structuredClone(storage.get(key)));
  kvs.set.mockImplementation(async (key, value, options) => {
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && storage.has(key)) throw new Error('Exists');
    storage.set(key, structuredClone(value));
  });
  kvs.delete.mockImplementation(async (key) => { storage.delete(key); });
  requestJira.mockImplementation(async (path) => {
    if (path === '/rest/api/3/project/100') return response(200, project);
    throw new Error(`Unexpected request ${path}`);
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const req = (payload = {}) => ({ context, payload });

test.each(Object.keys(handler))('%s rejects payload issue identifiers before Jira access', async (name) => {
  expect(await handler[name](req({ issueId: '99999' }))).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
  expect(kvs.set).not.toHaveBeenCalled();
});
function putSample(items = []) {
  const sample = { scenarioId: 'scenario', creatorAccountId: 'creator', items, status: 'creating',
    definitions: sampleDefinitions('2026-10-31'), issueTypeId: '5', linkTypeId: '2', notes: [] };
  storage.set('sample:100', sample);
  return sample;
}
async function prepareRemoval() {
  const plan = await handler.prepareSampleRemoval(req());
  expect(await handler.startSampleRemoval(req({ token: plan.token, confirmed: true }))).toEqual({ started: true });
  return plan;
}
test('sample create reserves atomically, refusing a second confirmed plan', async () => {
  const token = '11111111-1111-1111-1111-111111111111';
  const plan = { accountId: 'creator', expiresAt: Date.now() + 10000, projectId: '100', definitions: sampleDefinitions(), issueTypeId: '5', linkTypeId: '2' };
  storage.set(`sample-plan:${token}`, plan);
  expect(await handler.startSample(req({ token, confirmed: true }))).toEqual({ started: true });
  storage.set(`sample-plan:${token}`, plan);
  expect(await handler.startSample(req({ token, confirmed: true }))).toHaveProperty('error');
  expect(requestJira.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  expect(storage.get('sample:100').creatorAccountId).toBe('creator');
});
test('creation uses asUser current project/selected type and sets the property atomically', async () => {
  putSample();
  requestJira.mockResolvedValueOnce(response(200, project)).mockResolvedValueOnce(response(201, { id: '20', key: 'QL-20' }));
  expect(await handler.advanceSample(req())).toEqual({ done: false });
  const [path, options] = requestJira.mock.calls[1];
  expect(path).toBe('/rest/api/3/issue');
  expect(JSON.parse(options.body)).toMatchObject({ fields: { project: { id: '100' }, issuetype: { id: '5' }, labels: ['qualityloop-sample'] },
    properties: [{ key: 'qualityloop', value: { partOriginal: 'DEMO-4471-A', recordType: 'CAPA', supplier: 'DEMO-S-03', line: 'DEMO-L1' } }] });
  expect(storage.get('sample:100').items).toEqual([{ id: '20', key: 'QL-20' }]);
  expect(api.asApp).not.toHaveBeenCalled();
});
test.each(['classic', 'next-gen'])('prepare uses creator metadata for a %s project and prefers Task on a later page', async (style) => {
  requestJira.mockResolvedValueOnce(response(200, { ...project, style }))
    .mockResolvedValueOnce(response(200, { issueTypes: [
      { id: '3', name: 'Task', subtask: true }, { id: '4', name: 'Story', subtask: false },
    ], startAt: 0, maxResults: 2, total: 3 }))
    .mockResolvedValueOnce(response(200, { issueTypes: [{ id: '42', name: 'Task', subtask: false }], startAt: 2, total: 3 }))
    .mockResolvedValueOnce(response(200, { issueLinkTypes: [{ id: '2', inward: 'relates to', outward: 'relates to' }] }));
  const plan = await handler.prepareSample(req());
  expect(plan.lines[0]).toContain('using issue type Task');
  expect(plan.lines).toContain('All sample part numbers, suppliers and lines use the DEMO- prefix to keep matches separate from non-DEMO data.');
  expect(plan.lines.join(' ')).toContain('supplier DEMO-S-03, line DEMO-L1');
  expect(plan.lines.join(' ')).toContain('supplier DEMO-S-05, line DEMO-L2');
  expect(storage.get(`sample-plan:${plan.token}`).issueTypeId).toBe('42');
  expect(requestJira.mock.calls.map(([path]) => path)).toEqual([
    '/rest/api/3/project/100',
    '/rest/api/3/issue/createmeta/100/issuetypes?startAt=0&maxResults=200',
    '/rest/api/3/issue/createmeta/100/issuetypes?startAt=2&maxResults=200',
    '/rest/api/3/issueLinkType',
  ]);
  expect(api.asUser).toHaveBeenCalledTimes(4);
  expect(api.asApp).not.toHaveBeenCalled();
  expect(await handler.startSample(req({ token: plan.token, confirmed: true }))).toEqual({ started: true });
  requestJira.mockResolvedValueOnce(response(200, project)).mockResolvedValueOnce(response(201, { id: '20', key: 'QL-20' }));
  expect(await handler.advanceSample(req())).toEqual({ done: false });
  const [, createOptions] = requestJira.mock.calls.find(([, options]) => options.method === 'POST');
  expect(JSON.parse(createOptions.body).fields.issuetype).toEqual({ id: '42' });
  expect(api.asApp).not.toHaveBeenCalled();
});

test('prepare retains the first non-subtask across pages when Task is unavailable', async () => {
  requestJira.mockResolvedValueOnce(response(200, project))
    .mockResolvedValueOnce(response(200, { issueTypes: [
      { id: '3', name: 'Sub-task', subtask: true }, { id: '4', name: 'Story', subtask: false },
    ], total: 3 }))
    .mockResolvedValueOnce(response(200, { issueTypes: [{ id: '6', name: 'Bug', subtask: false }], total: 3 }))
    .mockResolvedValueOnce(response(200, { issueLinkTypes: [{ id: '2', inward: 'relates to', outward: 'relates to' }] }));
  const plan = await handler.prepareSample(req());
  expect(plan.lines[0]).toContain('using issue type Story');
  expect(storage.get(`sample-plan:${plan.token}`).issueTypeId).toBe('4');
});

test.each([{ issueTypes: [] }, { issueTypes: [{ id: '3', name: 'Task', subtask: true }] }])('prepare rejects metadata with no non-subtask type (%j)', async ({ issueTypes }) => {
  requestJira.mockResolvedValueOnce(response(200, project))
    .mockResolvedValueOnce(response(200, { issueTypes, total: issueTypes.length }));
  expect(await handler.prepareSample(req())).toEqual({ error: expect.stringContaining('No non-subtask issue type') });
  expect(kvs.set).not.toHaveBeenCalled();
  expect(requestJira).toHaveBeenCalledTimes(2);
});

test.each([401, 403, 404, 500])('metadata HTTP %s cannot produce a sample plan or any writes', async (status) => {
  requestJira.mockResolvedValueOnce(response(200, project)).mockResolvedValueOnce(response(status));
  const result = await handler.prepareSample(req());
  if ([403, 404].includes(status)) expect(result).toBeNull();
  else expect(result).toHaveProperty('error');
  expect(kvs.set).not.toHaveBeenCalled();
  expect(requestJira).toHaveBeenCalledTimes(2);
  expect(api.asApp).not.toHaveBeenCalled();
});

test('a later metadata error does not silently use an incomplete fallback', async () => {
  requestJira.mockResolvedValueOnce(response(200, project))
    .mockResolvedValueOnce(response(200, { issueTypes: [{ id: '4', name: 'Story', subtask: false }], total: 2 }))
    .mockResolvedValueOnce(response(500));
  expect(await handler.prepareSample(req())).toHaveProperty('error');
  expect(kvs.set).not.toHaveBeenCalled();
});
test.each([true, false])('sample CAPAs use available Done-category transitions or show a note (available: %s)', async (available) => {
  const sample = putSample(Array.from({ length: 5 }, (_, index) => ({ id: String(20 + index), key: `QL-${20 + index}` })));
  sample.transitionIndex = 0;
  requestJira.mockResolvedValueOnce(response(200, project)).mockResolvedValueOnce(response(200, sampleIssue('20')))
    .mockResolvedValueOnce(response(200, { transitions: [
      { id: '1', to: { statusCategory: { key: 'indeterminate' } } },
      ...(available ? [{ id: '2', to: { statusCategory: { key: 'done' } } }] : []),
    ] })).mockResolvedValue(response(204));
  expect(await handler.advanceSample(req())).toEqual({ done: false });
  const writes = requestJira.mock.calls.filter(([, options]) => options.method === 'POST');
  if (available) {
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('/rest/api/3/issue/20/transitions');
    expect(JSON.parse(writes[0][1].body)).toEqual({ transition: { id: '2' } });
  } else {
    expect(writes).toHaveLength(0);
    expect(storage.get('sample:100').notes[0]).toContain('QualityLoop closure date remains recorded');
  }
  expect(api.asApp).not.toHaveBeenCalled();
});
test('an ambiguous create is never retried automatically', async () => {
  putSample();
  requestJira.mockResolvedValueOnce(response(200, project)).mockRejectedValueOnce(new Error('timeout'));
  expect(await handler.advanceSample(req())).toHaveProperty('error');
  expect(await handler.advanceSample(req())).toHaveProperty('error');
  expect(requestJira.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
test('removal rechecks the label, ignores unregistered IDs and reports a denied delete', async () => {
  putSample([{ id: '20', key: 'QL-20' }, { id: '21', key: 'QL-21' }]);
  let lostLabel = false;
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/project/100') return response(200, project);
    if (path.endsWith('/20?fields=labels,project')) return response(200, sampleIssue('20', lostLabel ? [] : ['qualityloop-sample']));
    if (path.endsWith('/21?fields=labels,project')) return response(200, sampleIssue('21'));
    if (path === '/rest/api/3/issue/21' && options.method === 'DELETE') return response(403);
    throw new Error('Unexpected call');
  });
  const plan = await prepareRemoval();
  expect(plan.keys).toEqual(['QL-20', 'QL-21']);
  lostLabel = true;
  expect(await handler.removeSampleIssue(req({ token: plan.token, confirmed: true, index: 0 }))).toEqual({ handled: true });
  await handler.removeSampleIssue(req({ token: plan.token, confirmed: true, index: 1 }));
  expect(await handler.removeSampleIssue(req({ token: plan.token, confirmed: true, index: 2 }))).toHaveProperty('error');
  expect(requestJira.mock.calls.filter(([, options]) => options.method === 'DELETE').map(([path]) => path)).toEqual(['/rest/api/3/issue/21']);
  const finish = await handler.finishSampleRemoval(req({ token: plan.token, confirmed: true }));
  expect(finish.reports.join(' ')).toContain('QL-21: could not delete; check Jira before retrying.');
  expect(finish.reports.join(' ')).toContain('QL-20: label removed');
  expect(storage.has('sample:100')).toBe(false);
});
test('inaccessible sample keys are not disclosed, including during removal', async () => {
  putSample([{ id: '20', key: 'SECRET-20' }]);
  requestJira.mockImplementation(async (path) => path === '/rest/api/3/project/100' ? response(200, project) : response(404));
  expect(JSON.stringify(await handler.sampleStatus(req()))).not.toContain('SECRET');
  const plan = await prepareRemoval();
  expect(plan.keys).toEqual([]);
  const result = await handler.finishSampleRemoval(req({ token: plan.token, confirmed: true }));
  expect(JSON.stringify(result)).not.toMatch(/SECRET|20/);
  expect(result.reports).toEqual([]);
});
test('removal storage cleanup only selects records for successfully deleted registered samples', async () => {
  putSample([{ id: '20', key: 'QL-20' }, { id: '21', key: 'QL-21' }]);
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/project/100') return response(200, project);
    if (path.includes('/20?')) return response(200, sampleIssue('20'));
    if (path.includes('/21?')) return response(200, sampleIssue('21'));
    if (options.method === 'DELETE') return response(path.endsWith('/20') ? 204 : 403);
    throw new Error('Unexpected call');
  });
  const plan = await prepareRemoval();
  const payload = { token: plan.token, confirmed: true };
  await handler.removeSampleIssue(req({ ...payload, index: 0 }));
  await handler.removeSampleIssue(req({ ...payload, index: 1 }));
  const selected = { entity: 'pair-state', key: '20:10', value: { version: 1 } };
  recordPage.mockResolvedValue({ records: [selected, { entity: 'pair-state', key: '21:11', value: {} },
    { entity: 'pair-state', key: '999:12', value: {} }], nextCursor: 'next' });
  expect(await handler.cleanupSamplePage(req({ ...payload, entity: 'pair-state' }))).toEqual({ nextCursor: 'next' });
  expect(deleteRecordBatch).toHaveBeenCalledWith([selected]);
});
test('removal confirmation cannot race a growing creation list', async () => {
  const sample = putSample([]);
  const plan = await handler.prepareSampleRemoval(req());
  storage.set('sample:100', { ...sample, items: [{ id: '20', key: 'QL-20' }] });
  expect(await handler.startSampleRemoval(req({ token: plan.token, confirmed: true }))).toHaveProperty('error');
  expect(storage.get('sample:100').status).toBe('creating');
});
test('missing project context and payload issue identifiers cannot trigger work', async () => {
  expect(await handler.advanceSample({ context: { accountId: 'creator', extension: {} } })).toBeNull();
  expect(await handler.advanceSample(req({ issueId: '999' }))).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
});

test.each([403, 404])('removal reports reauthorise the issue before returning its key (HTTP %s)', async (status) => {
  putSample([{ id: '20', key: 'QL-20' }]);
  let denied = false;
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/project/100') return response(200, project);
    if (options.method === 'DELETE') return response(403);
    return denied ? response(status, { key: 'SECRET-20' }) : response(200, sampleIssue('20'));
  });
  const { token } = await prepareRemoval();
  await handler.removeSampleIssue(req({ token, confirmed: true, index: 0 }));
  denied = true;
  const result = await handler.finishSampleRemoval(req({ token, confirmed: true }));
  expect(result.reports).toEqual([]);
  expect(JSON.stringify(result)).not.toMatch(/QL-20|SECRET/);
});

test('sample resolver exceptions return safe messages and log no issue values', async () => {
  requestJira.mockRejectedValue(new Error('SECRET-20 private fields'));
  const result = await handler.sampleStatus(req());
  expect(result).toEqual({ error: expect.any(String) });
  expect(JSON.stringify([result, console.error.mock.calls])).not.toMatch(/SECRET|private|stack/);
});
