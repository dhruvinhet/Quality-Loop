jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {}; define(name, fn) { this.definitions[name] = fn; } getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn(), asApp: jest.fn() },
  route: (s, ...v) => s.reduce((out, part, i) => out + part + (v[i] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn(), set: jest.fn(), delete: jest.fn() } }));
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const Resolver = require('@forge/resolver').default;
const { registerPartMaintenance } = require('../partMaintenance');
const resolver = new Resolver(); registerPartMaintenance(resolver); const handler = resolver.getDefinitions();
const context = { accountId: 'admin', extension: { type: 'jira:adminPage' } };
const req = (payload = {}, ctx = context) => ({ context: ctx, payload });
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
let storage, records, request, admin, hidden;
const writes = () => request.mock.calls.filter(([, options]) => options.method === 'PUT');
beforeEach(() => {
  jest.clearAllMocks(); admin = true; hidden = new Set();
  storage = new Map([
    ['settings:100', { version: 1, scope: 'PROJECT', lookbackDays: 365, projectIds: [], revisionPreset: 'R_DIGITS' }],
    ['settings:200', { version: 2, scope: 'PROJECT', lookbackDays: 365, projectIds: [], revisionPreset: 'NONE' }],
  ]);
  records = new Map(['11', '22'].map((id, i) => [id, { id, key: `QA-${id}`, fields: { project: { id: i ? '200' : '100' } },
    properties: { qualityloop: { schemaVersion: 3, recordType: i ? 'CAPA' : 'NC', partOriginal: i ? ' P-100 -AA ' : 'P-100-R12',
      partNorm: i ? 'P-100 -AA' : 'P-100-R12', partBase: i ? 'P-100 ' : 'P-100-R12', partRevision: null,
      failureMode: 'FM-08', rootCause: 'Keep this', closedDate: null, effectivenessEvidenceUrl: 'http://example.com/legacy', updatedAt: 'old' } } }]));
  kvs.get.mockImplementation(async (key) => structuredClone(storage.get(key)));
  kvs.set.mockImplementation(async (key, value, options) => {
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && storage.has(key)) throw new Error('Locked');
    storage.set(key, structuredClone(value));
  });
  kvs.delete.mockImplementation(async (key) => storage.delete(key));
  request = jest.fn(async (path, options) => {
    if (path.includes('mypermissions')) return response(200, { permissions: { ADMINISTER: { havePermission: admin } } });
    if (path === '/rest/api/3/search/jql') return response(200, { issues: [...records.keys()].map((id) => ({ id })), isLast: true });
    const id = path.match(/issue\/(\d+)/)?.[1];
    if (hidden.has(id)) return response(403, { key: 'SECRET' });
    if (options.method === 'PUT') { records.get(id).properties.qualityloop = JSON.parse(options.body); return response(204); }
    return response(200, records.get(id));
  });
  api.asUser.mockReturnValue({ requestJira: request });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const scan = () => handler.scanPartIndexes(req());
const apply = (plan, ctx = context) => handler.repairPartIndexes(req({ token: plan.token, confirmation: plan.lines.join('\n') }, ctx));

test('scan proposes every changed field using each record own project preset; confirmation preserves other fields', async () => {
  const originals = structuredClone(records);
  const plan = await scan();
  expect(writes()).toEqual([]);
  expect(plan.lines).toHaveLength(2);
  expect(plan.lines[0]).toContain('partBase = "P-100", partRevision = "R12"');
  expect(plan.lines[1]).toContain('partBase = "P-100-AA", partRevision = null');
  expect(plan.lines.join('')).not.toMatch(/admin|Keep this|http/);
  expect(await apply(plan)).toEqual({ updated: 2, skipped: 0 });
  expect(writes()).toHaveLength(2);
  for (const [id, issue] of records) {
    const { partNorm, partBase, partRevision, ...rest } = issue.properties.qualityloop;
    const previous = { ...originals.get(id).properties.qualityloop };
    for (const key of ['partNorm', 'partBase', 'partRevision']) delete previous[key];
    expect(rest).toEqual(previous);
    expect(partNorm).toBe(id === '11' ? 'P-100-R12' : 'P-100-AA');
    expect(partBase).toBe(id === '11' ? 'P-100' : 'P-100-AA');
    expect(partRevision).toBe(id === '11' ? 'R12' : null);
  }
  // Replayed or lost-response confirmations cannot write twice.
  expect(await apply(plan)).toEqual({ updated: 0, skipped: 2 });
  expect(writes()).toHaveLength(2);
  expect((await scan()).lines).toEqual([]);
  expect(api.asApp).not.toHaveBeenCalled();
});

test('tampered confirmation, wrong account and payload IDs cannot authorize writes', async () => {
  const plan = await scan();
  expect(await handler.repairPartIndexes(req({ token: plan.token, confirmation: 'Update anything' }))).toHaveProperty('error');
  expect(await apply(plan, { ...context, accountId: 'someone-else' })).toHaveProperty('error');
  expect(await handler.scanPartIndexes(req({ issueId: '11' }))).toHaveProperty('error');
  expect(writes()).toEqual([]);
});

test.each(['edit', 'preset', 'move'])('a concurrent %s requires a new preview and is not overwritten', async (change) => {
  const plan = await scan();
  if (change === 'edit') records.get('11').properties.qualityloop.rootCause = 'New edit';
  if (change === 'preset') storage.get('settings:100').revisionPreset = 'NONE';
  if (change === 'move') records.get('11').fields.project.id = '200';
  expect(await apply(plan)).toEqual({ updated: 1, skipped: 1 });
  expect(writes()[0][0]).toContain('/issue/22/');
});

test('denied issues are omitted from preview and repair counts, with no asApp reads', async () => {
  hidden.add('22');
  const plan = await scan();
  expect(plan.lines).toHaveLength(1);
  hidden.add('11');
  expect(await apply(plan)).toEqual({ updated: 0, skipped: 0 });
  expect(writes()).toEqual([]);
  expect(api.asApp).not.toHaveBeenCalled();
});

test('admin permission is required both before scanning and again before each write', async () => {
  const plan = await scan(); admin = false;
  expect(await scan()).toBeNull(); expect(await apply(plan)).toBeNull();
  admin = true;
  const original = request.getMockImplementation(); let checks = 0;
  request.mockImplementation((path, options) => path.includes('mypermissions')
    ? response(200, { permissions: { ADMINISTER: { havePermission: ++checks === 1 } } }) : original(path, options));
  expect(await apply(plan)).toBeNull(); expect(writes()).toEqual([]);
});

test('scan pages are bounded to ten, use enhanced asUser search and expose continuation', async () => {
  const original = request.getMockImplementation();
  request.mockImplementation((path, options) => path === '/rest/api/3/search/jql'
    ? response(200, { issues: [], nextPageToken: 'next-page', isLast: false }) : original(path, options));
  const page = await handler.scanPartIndexes(req({ cursor: 'previous-page' }));
  expect(page).toMatchObject({ lines: [], nextCursor: 'next-page' });
  expect(JSON.parse(request.mock.calls.find(([path]) => path === '/rest/api/3/search/jql')[1].body)).toMatchObject({
    jql: '(qlRecordType = "NC" OR qlRecordType = "CAPA") ORDER BY key ASC', maxResults: 10, nextPageToken: 'previous-page',
  });
});
