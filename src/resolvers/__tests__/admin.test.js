jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn(), asApp: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn(), set: jest.fn(), delete: jest.fn(), entity: jest.fn(), query: jest.fn() },
  WhereConditions: { beginsWith: (value) => ({ beginsWith: value }) } }));
jest.mock('../cleanupStore', () => ({ recordPage: jest.fn(), backfillPair: jest.fn(), deleteRecordBatch: jest.fn() }));
const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const { recordPage, backfillPair, deleteRecordBatch } = require('../cleanupStore');
const { handler } = require('../admin');
const context = { accountId: 'admin', extension: { type: 'jira:adminPage' } };
const req = (payload = {}, ctx = context) => ({ context: ctx, payload });
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const userRequest = jest.fn();
const appRequest = jest.fn();
const record = { entity: 'decision', key: '20:10:one', value: { issueId: '10', capaId: '20', reason: 'Private narrative' } };
let storage;
beforeEach(() => {
  jest.clearAllMocks();
  storage = new Map();
  api.asUser.mockReturnValue({ requestJira: userRequest });
  api.asApp.mockReturnValue({ requestJira: appRequest });
  userRequest.mockReset().mockImplementation(async (path) => path.includes('mypermissions')
    ? response(200, { permissions: { ADMINISTER: { havePermission: true } } })
    : response(200, { id: path.match(/issue\/(\d+)/)?.[1] }));
  appRequest.mockReset().mockImplementation(async (path) => response(path.includes('/20?') ? 404 : 200, { fields: { summary: 'Secret Jira summary' } }));
  kvs.get.mockImplementation(async (key) => storage.get(key));
  kvs.set.mockImplementation(async (key, value) => { storage.set(key, value); });
  kvs.delete.mockImplementation(async (key) => { storage.delete(key); });
  kvs.entity.mockReturnValue({ get: async () => record.value });
  recordPage.mockResolvedValue({ records: [record] });
  backfillPair.mockResolvedValue(false);
});
async function scan() {
  const { token } = await handler.startOrphanScan(req());
  return { token, page: await handler.findOrphanPage(req({ token, entity: 'decision' })) };
}

test.each(Object.keys(handler))('%s rejects payload issue identifiers before Jira access', async (name) => {
  expect(await handler[name](req({ issueId: '99999' }))).toHaveProperty('error');
  expect(userRequest).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
  expect(kvs.set).not.toHaveBeenCalled();
});
test('admin scan checks both issue references asUser on every page and counts only visible records', async () => {
  const { token, page } = await scan();
  expect(page).toEqual({ entity: 'decision', scanned: 1, backfilled: 0, backfillPending: 0, nextCursor: undefined });
  expect(JSON.stringify(page)).not.toMatch(/Secret|Private|summary|reason|20:10|missingIds|unknownIds/);
  expect(backfillPair).toHaveBeenCalledWith(record);
  await handler.findOrphanPage(req({ token, entity: 'decision', cursor: 'next' }));
  expect(userRequest.mock.calls.filter(([path]) => path.includes('/issue/'))).toHaveLength(4);
  expect(api.asApp).not.toHaveBeenCalled();
});

test.each([403, 404])('denied reference HTTP %s is omitted from counts and backfill; never proof of deletion', async (status) => {
  const json = jest.fn();
  userRequest.mockImplementation(async (path) => path.includes('mypermissions')
    ? response(200, { permissions: { ADMINISTER: { havePermission: true } } })
    : path.includes('/20?') ? { status, ok: false, json } : response(200, { id: '10' }));
  const { page } = await scan();
  expect(page).toEqual({ entity: 'decision', scanned: 0, backfilled: 0, backfillPending: 0, nextCursor: undefined });
  expect(json).not.toHaveBeenCalled();
  expect(backfillPair).not.toHaveBeenCalled();
  expect(deleteRecordBatch).not.toHaveBeenCalled();
  expect(api.asApp).not.toHaveBeenCalled();
});

test('a non-admin or another page cannot scan or delete app records', async () => {
  userRequest.mockResolvedValue(response(200, { permissions: { ADMINISTER: { havePermission: false } } }));
  expect(await handler.startOrphanScan(req())).toBeNull();
  expect(await handler.findOrphanPage(req({ entity: 'decision' }))).toBeNull();
  expect(await handler.deleteOrphanPage(req({ confirmed: true }))).toBeNull();
  expect(await handler.startOrphanScan(req({}, { ...context, extension: { type: 'jira:issuePanel' } }))).toBeNull();
  expect(recordPage).not.toHaveBeenCalled();
  expect(api.asApp).not.toHaveBeenCalled();
});

test('old app-context review tickets cannot delete data after release hardening', async () => {
  const token = '11111111-1111-1111-1111-111111111111';
  storage.set(`orphan-review:${token}`, { records: [record], accountId: context.accountId, expiresAt: Date.now() + 10000 });
  expect(await handler.deleteOrphanPage(req({ token, confirmed: true }))).toEqual({ error: expect.stringContaining('No records were deleted') });
  expect(deleteRecordBatch).not.toHaveBeenCalled();
  expect(recordPage).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
});

test('scan tokens cannot be used by another admin account', async () => {
  const { token } = await handler.startOrphanScan(req());
  expect(await handler.findOrphanPage(req({ token, entity: 'decision' }, { ...context, accountId: 'different-admin' }))).toHaveProperty('error');
  expect(recordPage).not.toHaveBeenCalled();
});

test('an infrastructure error returns a safe message and logs no exception values', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    userRequest.mockRejectedValue(new Error('SECRET-ISSUE private narrative https://private/evidence'));
    const result = await handler.startOrphanScan(req());
    expect(result).toEqual({ error: expect.any(String) });
    expect(JSON.stringify([result, spy.mock.calls])).not.toMatch(/SECRET|private|stack/);
    expect(spy).toHaveBeenCalledWith('QualityLoop startOrphanScan failed.');
  } finally { spy.mockRestore(); }
});

function sampleLinksPage(entries, nextCursor) {
  const query = { where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), cursor: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue({ results: entries.map(([key]) => ({ key, value: { items: [{ key: 'STALE-SECRET' }] } })), nextCursor }) };
  kvs.query.mockReturnValue(query);
  for (const [key, id] of entries) storage.set(key, { status: 'complete', items: [null, null, null, null, { id, key: 'STALE-SECRET' }] });
  return query;
}

test('checklist uses current registrations, pages links and returns only fresh browsable NC keys', async () => {
  const query = sampleLinksPage([['sample:100', '40']], 'next-page');
  userRequest.mockImplementation(async (path) => path.includes('mypermissions')
    ? response(200, { permissions: { ADMINISTER: { havePermission: true } } })
    : response(200, { id: '40', key: 'QL-40', fields: { labels: ['qualityloop-sample'], project: { id: '100' } },
      properties: { qualityloop: { recordType: 'NC' } } }));
  expect(await handler.sampleNcLinks(req({ cursor: 'previous-page' }))).toEqual({ keys: ['QL-40'], nextCursor: 'next-page' });
  expect(query.where).toHaveBeenCalledWith('key', { beginsWith: 'sample:' });
  expect(query.cursor).toHaveBeenCalledWith('previous-page');
  expect(userRequest).toHaveBeenCalledWith('/rest/api/3/issue/40?fields=labels,project&properties=qualityloop', expect.anything());
  expect(appRequest).not.toHaveBeenCalled();
  expect(kvs.set).not.toHaveBeenCalled();
});

test.each([403, 404])('checklist never parses or discloses a sample NC denied with HTTP %s', async (status) => {
  sampleLinksPage([['sample:100', '40']]);
  const denied = { status, ok: false, json: jest.fn() };
  userRequest.mockResolvedValueOnce(response(200, { permissions: { ADMINISTER: { havePermission: true } } })).mockResolvedValueOnce(denied);
  expect(await handler.sampleNcLinks(req())).toEqual({ keys: [], nextCursor: undefined });
  expect(denied.json).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
});

test.each(['deleted', 'removing', 'label removed', 'project changed', 'type changed'])('checklist drops a sample that is %s', async (change) => {
  sampleLinksPage([['sample:100', '40']]);
  if (change === 'deleted') storage.delete('sample:100');
  if (change === 'removing') storage.get('sample:100').status = 'removing';
  userRequest.mockResolvedValueOnce(response(200, { permissions: { ADMINISTER: { havePermission: true } } }))
    .mockResolvedValueOnce(response(200, { id: '40', key: 'SECRET-40', fields: {
      labels: change === 'label removed' ? [] : ['qualityloop-sample'], project: { id: change === 'project changed' ? '999' : '100' },
    }, properties: { qualityloop: { recordType: change === 'type changed' ? 'CAPA' : 'NC' } } }));
  expect(await handler.sampleNcLinks(req())).toEqual({ keys: [], nextCursor: undefined });
});

test('checklist lookup rejects non-admin contexts, invalid cursors and payload issue IDs', async () => {
  userRequest.mockResolvedValue(response(200, { permissions: { ADMINISTER: { havePermission: false } } }));
  expect(await handler.sampleNcLinks(req())).toBeNull();
  expect(await handler.sampleNcLinks(req({}, { ...context, extension: { type: 'jira:issuePanel' } }))).toBeNull();
  userRequest.mockResolvedValue(response(200, { permissions: { ADMINISTER: { havePermission: true } } }));
  expect(await handler.sampleNcLinks(req({ cursor: '' }))).toHaveProperty('error');
  expect(await handler.sampleNcLinks(req({ issueId: '999' }))).toHaveProperty('error');
  expect(kvs.query).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
});
