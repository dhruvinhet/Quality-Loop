jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {}; define(name, fn) { this.definitions[name] = fn; } getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn() },
  route: (s, ...v) => s.reduce((out, part, i) => out + part + (v[i] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn(), set: jest.fn(), delete: jest.fn() } }));
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const Resolver = require('@forge/resolver').default;
const { registerSearchSettings, searchForIssue } = require('../searchSettings');
const resolver = new Resolver(); registerSearchSettings(resolver); const handler = resolver.getDefinitions();
const context = { accountId: 'viewer', extension: { type: 'jira:projectPage', project: { id: '100' } } };
const req = (payload = {}, ctx = context) => ({ context: ctx, payload });
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
let storage, request, admin, hidden;
beforeEach(() => {
  jest.clearAllMocks(); storage = new Map(); admin = true; hidden = new Set();
  kvs.get.mockImplementation(async (key) => structuredClone(storage.get(key)));
  kvs.set.mockImplementation(async (key, value, options) => {
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && storage.has(key)) throw new Error('Locked');
    storage.set(key, structuredClone(value));
  });
  kvs.delete.mockImplementation(async (key) => storage.delete(key));
  request = jest.fn(async (path) => {
    if (path.startsWith('/rest/api/3/mypermissions')) return response(200, { permissions: { ADMINISTER_PROJECTS: { havePermission: admin } } });
    const ref = path.split('/').at(-1);
    if (hidden.has(ref)) return response(403, { name: 'Hidden project' });
    const project = [{ id: '100', key: 'QA' }, { id: '200', key: 'OPS' }, { id: '300', key: 'SUP' }].find((p) => p.id === ref || p.key === ref);
    return response(project ? 200 : 404, project);
  });
  api.asUser.mockReturnValue({ requestJira: request });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const payload = { scope: 'LISTED', lookbackDays: 730, projectKeys: 'ops, SUP ops QA', expectedVersion: 0, revisionPreset: 'R_DIGITS' };

test('any project browser can read defaults; project-admin permission is checked in that exact project', async () => {
  admin = false;
  const result = await handler.getProjectSearchSettings(req());
  expect(result).toMatchObject({ settings: { scope: 'PROJECT', lookbackDays: 365, version: 0 }, canAdmin: false });
  expect(kvs.set).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith('/rest/api/3/mypermissions?projectId=100&permissions=ADMINISTER_PROJECTS,ADMINISTER', expect.any(Object));
});

test.each([
  [true, false, true],
  [false, true, true],
  [true, true, true],
  [false, false, false],
])('project admin=%s Jira admin=%s can view editing controls and save=%s', async (projectAdmin, jiraAdmin, allowed) => {
  const original = request.getMockImplementation();
  request.mockImplementation((path, options) => path.startsWith('/rest/api/3/mypermissions')
    ? response(200, { permissions: { ADMINISTER_PROJECTS: { havePermission: projectAdmin }, ADMINISTER: { havePermission: jiraAdmin } } })
    : original(path, options));
  expect((await handler.getProjectSearchSettings(req())).canAdmin).toBe(allowed);
  const result = await handler.saveProjectSearchSettings(req(payload));
  if (allowed) {
    expect(result.canAdmin).toBe(true);
    expect(storage.get('settings:100')).toMatchObject({ scope: 'LISTED', lookbackDays: 730 });
  } else {
    expect(result).toEqual({ error: 'Administer Projects on this project or Jira administrator permission is required to change these settings.' });
    expect(kvs.set).not.toHaveBeenCalled();
  }
  const checks = request.mock.calls.filter(([path]) => path.includes('/mypermissions'));
  expect(checks).toHaveLength(allowed ? 4 : 2); // View, then save's two gates and returned view.
  expect(checks.every(([path]) => path === '/rest/api/3/mypermissions?projectId=100&permissions=ADMINISTER_PROJECTS,ADMINISTER')).toBe(true);
});

test.each(['ADMINISTER_PROJECTS', 'ADMINISTER'])('revoked %s permission is rejected again immediately before the settings write', async (grant) => {
  const original = request.getMockImplementation(); let checks = 0;
  request.mockImplementation((path, options) => path.includes('/mypermissions')
    ? response(200, { permissions: { [grant]: { havePermission: ++checks === 1 } } }) : original(path, options));
  expect(await handler.saveProjectSearchSettings(req(payload))).toEqual({
    error: 'Administer Projects on this project or Jira administrator permission is required to change these settings.',
  });
  expect(checks).toBe(2);
  expect(storage.has('settings:100')).toBe(false);
  expect(storage.has('settings-lock:100')).toBe(false);
});
test('non-admin cannot save, even if an unrelated project permits administration', async () => {
  request.mockImplementation(async (path) => path.startsWith('/rest/api/3/project/') ? response(200, { id: '100', key: 'QA' })
    : response(200, { permissions: { ADMINISTER_PROJECTS: { havePermission: !path.includes('projectId=100') } } }));
  expect(await handler.saveProjectSearchSettings(req(payload))).toHaveProperty('error', expect.stringContaining('Administer Projects'));
  expect(kvs.get).not.toHaveBeenCalled(); expect(kvs.set).not.toHaveBeenCalled();
});
test('listed keys are validated asUser and stored by id, with the current project implicit', async () => {
  const result = await handler.saveProjectSearchSettings(req(payload));
  expect(storage.get('settings:100')).toEqual({ version: 1, scope: 'LISTED', lookbackDays: 730, projectIds: ['200', '300'], revisionPreset: 'R_DIGITS' });
  expect(result.listedProjectKeys).toEqual(['OPS', 'SUP']);
  expect(request.mock.calls.map(([path]) => path)).toContain('/rest/api/3/project/OPS');
  expect(api.asUser).toHaveBeenCalledTimes(request.mock.calls.length);
});
test.each(['UNKNOWN', 'OPS'])('unknown or unbrowsable listed key %s has a clear error and no settings write', async (key) => {
  hidden.add('OPS');
  expect(await handler.saveProjectSearchSettings(req({ ...payload, projectKeys: key })))
    .toHaveProperty('error', expect.stringContaining(`Project ${key} was not found or you cannot browse it`));
  expect(kvs.set).not.toHaveBeenCalled();
});
test('getter and search never expose unbrowsable listed keys or ids', async () => {
  storage.set('settings:100', { version: 2, scope: 'LISTED', lookbackDays: 1095, projectIds: ['200', '300'] });
  hidden.add('300');
  const result = await handler.getProjectSearchSettings(req());
  expect(result.listedProjectKeys).toEqual(['OPS']);
  expect(JSON.stringify(result)).not.toMatch(/300|SUP|Hidden/);
  const search = await searchForIssue({ fields: { project: { id: '100' } } });
  expect(search.projectIds).toEqual(['100', '200']);
});
test('NC project selects its own stored scope and window, not the CAPA project', async () => {
  storage.set('settings:100', { version: 1, scope: 'ALL', lookbackDays: 730, projectIds: [] });
  storage.set('settings:200', { version: 2, scope: 'PROJECT', lookbackDays: 90, projectIds: [] });
  expect(await searchForIssue({ fields: { project: { id: '100' } } })).toMatchObject({ scope: 'ALL', lookbackDays: 730, projectIds: undefined });
  expect(await searchForIssue({ fields: { project: { id: '200' } } })).toMatchObject({ scope: 'PROJECT', lookbackDays: 90, projectIds: ['200'] });
});
test('invalid context/payload, unsupported window, stale revision and permission loss cannot write settings', async () => {
  expect(await handler.saveProjectSearchSettings(req({ ...payload, projectId: '200' }))).toHaveProperty('error');
  expect(request).not.toHaveBeenCalled();
  expect(await handler.getProjectSearchSettings(req({}, { ...context, extension: { type: 'jira:issuePanel', project: { id: '100' } } }))).toBeNull();
  expect(await handler.saveProjectSearchSettings(req({ ...payload, lookbackDays: 400 }))).toHaveProperty('error');
  expect(await handler.saveProjectSearchSettings(req({ ...payload, expectedVersion: 5 }))).toHaveProperty('error', expect.stringContaining('changed'));
  const original = request.getMockImplementation(); let checks = 0;
  request.mockImplementation((path, options) => path.includes('mypermissions')
    ? response(200, { permissions: { ADMINISTER_PROJECTS: { havePermission: ++checks === 1 } } }) : original(path, options));
  expect(await handler.saveProjectSearchSettings(req(payload))).toHaveProperty('error', expect.stringContaining('Administer Projects'));
  expect(storage.has('settings:100')).toBe(false);
});

test('malformed settings never widen to all projects, and concurrent edits cannot overwrite the lock owner', async () => {
  storage.set('settings:100', { scope: 'BAD', lookbackDays: 365 });
  expect(await handler.getProjectSearchSettings(req())).toHaveProperty('error');
  await expect(searchForIssue({ fields: { project: { id: '100' } } })).rejects.toThrow();
  storage.delete('settings:100');
  storage.set('settings-lock:100', { token: 'another-editor' });
  expect(await handler.saveProjectSearchSettings(req(payload))).toHaveProperty('error', expect.stringContaining('busy'));
  expect(storage.get('settings-lock:100')).toEqual({ token: 'another-editor' });
  expect(storage.has('settings:100')).toBe(false);
});

test('missing NC project metadata or a denied project context cannot expose settings', async () => {
  await expect(searchForIssue({ fields: {} })).rejects.toThrow();
  expect(kvs.get).not.toHaveBeenCalled();
  hidden.add('100');
  expect(await handler.getProjectSearchSettings(req())).toBeNull();
  expect(await handler.saveProjectSearchSettings(req(payload))).toBeNull();
  expect(kvs.get).not.toHaveBeenCalled(); expect(kvs.set).not.toHaveBeenCalled();
});


test('preset round trip shares the settings version check and legacy clients preserve the current preset', async () => {
  const first = await handler.saveProjectSearchSettings(req(payload));
  expect(first.settings).toMatchObject({ version: 1, revisionPreset: 'R_DIGITS' });
  expect(await handler.saveProjectSearchSettings(req({ ...payload, revisionPreset: 'NONE' }))).toHaveProperty('error', expect.stringContaining('changed'));
  const { revisionPreset, ...legacyPayload } = payload;
  expect(revisionPreset).toBe('R_DIGITS');
  const legacy = await handler.saveProjectSearchSettings(req({ ...legacyPayload, expectedVersion: 1 }));
  expect(legacy.settings.revisionPreset).toBe('R_DIGITS');
  const next = await handler.saveProjectSearchSettings(req({ ...payload, revisionPreset: 'NONE', expectedVersion: 2 }));
  expect(next.settings).toMatchObject({ version: 3, revisionPreset: 'NONE' });
});

test.each(['^(.+)-(.*)$', 'custom', null, {}, ['NONE']])('free regex/invalid revision preset %j is rejected without writes', async (revisionPreset) => {
  expect(await handler.saveProjectSearchSettings(req({ ...payload, revisionPreset }))).toHaveProperty('error', 'Select a supported revision preset.');
  expect(kvs.set).not.toHaveBeenCalled();
});

test('legacy stored settings default to letters; corrupt preset fails closed', async () => {
  storage.set('settings:100', { version: 1, scope: 'PROJECT', lookbackDays: 365, projectIds: [] });
  expect((await handler.getProjectSearchSettings(req())).settings.revisionPreset).toBe('LETTERS');
  storage.get('settings:100').revisionPreset = 'custom';
  expect(await handler.getProjectSearchSettings(req())).toHaveProperty('error');
});
