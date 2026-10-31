jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn(), asApp: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn(), set: jest.fn(), delete: jest.fn(), entity: jest.fn() } }));
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
  userRequest.mockReset().mockResolvedValue(response(200, { permissions: { ADMINISTER: { havePermission: true } } }));
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
test('admin scans return only counts and IDs, deduplicating issue checks across pages', async () => {
  const { token, page } = await scan();
  expect(page).toMatchObject({ orphanCount: 1, missingIds: ['20'], recordIds: ['20:10:one'] });
  expect(JSON.stringify(page)).not.toMatch(/Secret|Private|summary|reason/);
  await handler.findOrphanPage(req({ token, entity: 'decision', cursor: 'next' }));
  expect(appRequest).toHaveBeenCalledTimes(2);
  expect(userRequest.mock.calls.every(([path]) => path === '/rest/api/3/mypermissions?permissions=ADMINISTER')).toBe(true);
});
test('a non-admin or another page cannot scan or delete app records', async () => {
  userRequest.mockResolvedValue(response(200, { permissions: { ADMINISTER: { havePermission: false } } }));
  expect(await handler.startOrphanScan(req())).toBeNull();
  expect(await handler.findOrphanPage(req({ entity: 'decision' }))).toBeNull();
  expect(await handler.deleteOrphanPage(req({ confirmed: true }))).toBeNull();
  expect(await handler.startOrphanScan(req({}, { ...context, extension: { type: 'jira:issuePanel' } }))).toBeNull();
  expect(recordPage).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
});
test('orphan deletion reauthorises admin and rechecks existence without trusting scan cache', async () => {
  const { page } = await scan();
  appRequest.mockResolvedValue(response(403));
  expect(await handler.deleteOrphanPage(req({ token: page.token, confirmed: true }))).toEqual({ deleted: 0, retained: 1 });
  expect(deleteRecordBatch).toHaveBeenCalledWith([]);
});
test('only confirmed server-held orphan records may be deleted', async () => {
  const { page } = await scan();
  expect(await handler.deleteOrphanPage(req({ token: page.token }))).toHaveProperty('error');
  expect(await handler.deleteOrphanPage(req({ token: page.token, confirmed: true, issueId: '999' }))).toHaveProperty('error');
  expect(deleteRecordBatch).not.toHaveBeenCalled();
  expect(await handler.deleteOrphanPage(req({ token: page.token, confirmed: true }))).toEqual({ deleted: 1, retained: 0 });
  expect(deleteRecordBatch).toHaveBeenCalledWith([record]);
});
test('review tokens cannot be used by another admin account', async () => {
  const { page } = await scan();
  expect(await handler.deleteOrphanPage(req({ token: page.token, confirmed: true }, { ...context, accountId: 'different-admin' }))).toHaveProperty('error');
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});
