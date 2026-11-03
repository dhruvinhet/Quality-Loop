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
    : path.startsWith('/rest/api/3/project/search?') ? response(200, { startAt: 0, total: 0, isLast: true, values: [] })
      : response(200, { id: path.match(/issue\/(\d+)/)?.[1] }));
  appRequest.mockReset().mockImplementation(async (path) => response(path.includes('/20?') ? 404 : 200, { fields: { summary: 'Secret Jira summary' } }));
  kvs.get.mockImplementation(async (key) => storage.has(key) ? JSON.parse(JSON.stringify(storage.get(key))) : undefined);
  kvs.set.mockImplementation(async (key, value, options) => {
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && storage.has(key)) throw new Error('Locked');
    storage.set(key, JSON.parse(JSON.stringify(value)));
  });
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

function healthRecords() {
  const rows = new Map([['decision', [record]], ['pair-state', [{ entity: 'pair-state', key: '20:10', value: { version: 1 } }]]]);
  const records = new Map([...rows.values()].flat().map((item) => [`${item.entity}/${item.key}`, item.value]));
  recordPage.mockImplementation(async (entity) => ({ records: rows.get(entity) }));
  kvs.entity.mockImplementation((entity) => ({ get: async (key) => records.get(`${entity}/${key}`) }));
  deleteRecordBatch.mockImplementation(async (batch) => { for (const item of batch) records.delete(`${item.entity}/${item.key}`); });
  return { rows, records };
}
async function healthScan() {
  const { token } = await handler.startDataHealthCheck(req());
  let page;
  for (let i = 0; i < 10; i++) {
    page = await handler.checkOrphanPage(req({ token }));
    if (page.scanComplete || page.error) break;
  }
  return { token, page };
}
const removeHealth = (token, expectedCount, confirmed = true) => handler.removeOrphanPage(req({ token, expectedCount, confirmed }));

test('Data health scans both entity types asApp, counts 404s and never parses or exposes issue content', async () => {
  healthRecords();
  const json = jest.fn(() => { throw new Error('Must not parse Jira content'); });
  appRequest.mockImplementation(async (path) => ({ status: path.includes('/20?') ? 404 : 200, json }));
  const { page } = await healthScan();
  expect(page).toMatchObject({ found: 2, scanned: 2, unknown: 0, scanComplete: true });
  expect(json).not.toHaveBeenCalled();
  expect(JSON.stringify(page)).not.toMatch(/Private|Secret|summary|reason|value|capaId|issueId/);
  expect(appRequest.mock.calls.every(([path]) => /^\/rest\/api\/3\/issue\/\d+\?fields=id$/.test(path))).toBe(true);
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});

test.each([403, 500, 429, 401, 'transport'])('Data health never treats HTTP/error %s as deletion', async (status) => {
  healthRecords();
  appRequest.mockImplementation(async () => {
    if (status === 'transport') throw new Error('SECRET');
    return response(status, { fields: { summary: 'SECRET' } });
  });
  const { page } = await healthScan();
  expect(page).toMatchObject({ found: 0, unknown: 2, scanComplete: true });
  expect(JSON.stringify(page)).not.toContain('SECRET');
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});

test('removal requires completed scan, exact count, confirmation, and a fresh 404 for every deleted record', async () => {
  const { records } = healthRecords();
  const { token } = await handler.startDataHealthCheck(req());
  expect(await removeHealth(token, 0)).toHaveProperty('error');
  await handler.checkOrphanPage(req({ token }));
  const summary = await handler.checkOrphanPage(req({ token }));
  expect(await removeHealth(token, 1)).toHaveProperty('error');
  expect(await removeHealth(token, 2, false)).toHaveProperty('error');
  expect(deleteRecordBatch).not.toHaveBeenCalled();
  appRequest.mockClear();
  let result = await removeHealth(token, summary.found);
  expect(result.removed).toBe(1);
  result = await removeHealth(token, summary.found);
  expect(result).toMatchObject({ removed: 2, removeComplete: true });
  expect(appRequest).toHaveBeenCalledTimes(4);
  expect(records.size).toBe(0);
  await removeHealth(token, summary.found);
  expect(deleteRecordBatch).toHaveBeenCalledTimes(2);
});

test.each([200, 403, 500, 'transport'])('removal re-check HTTP/error %s retains previously orphaned records', async (status) => {
  healthRecords();
  const { token } = await healthScan();
  appRequest.mockImplementation(async () => {
    if (status === 'transport') throw new Error('SECRET');
    return response(status, {});
  });
  await removeHealth(token, 2);
  const result = await removeHealth(token, 2);
  expect(result).toMatchObject({ removed: 0, retained: 2, removeComplete: true });
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});

test('deletion directly re-reads the record instead of using its reviewed references', async () => {
  const { records } = healthRecords();
  const { token } = await healthScan();
  records.set(`decision/${record.key}`, { issueId: '30', capaId: '40' });
  const result = await removeHealth(token, 2);
  expect(result).toMatchObject({ removed: 0, retained: 1 });
  expect(appRequest.mock.calls.slice(-2).map(([path]) => path)).toEqual(['/rest/api/3/issue/30?fields=id', '/rest/api/3/issue/40?fields=id']);
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});

test('Data health paginates empty pages and both entities, using only server-owned cursors', async () => {
  healthRecords();
  recordPage.mockImplementation(async (entity, cursor) => entity === 'decision' && !cursor
    ? { records: [], nextCursor: 'next-decision-page' }
    : { records: entity === 'decision' ? [record] : [] });
  const { page } = await healthScan();
  expect(page).toMatchObject({ scanned: 1, found: 1, scanComplete: true });
  expect(recordPage.mock.calls.map(([entity, cursor]) => [entity, cursor])).toEqual([
    ['decision', undefined], ['decision', 'next-decision-page'], ['pair-state', undefined],
  ]);
});

test.each(['startDataHealthCheck', 'checkOrphanPage', 'removeOrphanPage'])('%s rejects non-admin callers before storage or app-context access', async (name) => {
  userRequest.mockResolvedValue(response(200, { permissions: { ADMINISTER: { havePermission: false } } }));
  const payload = name === 'startDataHealthCheck' ? {} : name === 'checkOrphanPage' ? { token: 'x' } : { token: 'x', confirmed: true, expectedCount: 2 };
  expect(await handler[name](req(payload))).toBeNull();
  expect(await handler[name](req(payload, { ...context, extension: { type: 'jira:issuePanel' } }))).toBeNull();
  expect(recordPage).not.toHaveBeenCalled();
  expect(kvs.get).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
});

test('Data health tickets are account-bound, expire, and cannot reuse old review tickets', async () => {
  healthRecords();
  const { token } = await handler.startDataHealthCheck(req());
  expect(await handler.checkOrphanPage(req({ token }, { ...context, accountId: 'other-admin' }))).toHaveProperty('error');
  storage.get(`data-health:${token}`).expiresAt = Date.now() - 1;
  expect(await handler.checkOrphanPage(req({ token }))).toHaveProperty('error');
  expect(await handler.removeOrphanPage(req({ token, confirmed: true, expectedCount: 0 }))).toHaveProperty('error');
  expect(appRequest).not.toHaveBeenCalled();
});

test('a locked Data health ticket cannot run concurrent pages or change its counts', async () => {
  healthRecords();
  const { token } = await handler.startDataHealthCheck(req());
  storage.set(`data-health-lock:${token}`, true);
  expect(await handler.checkOrphanPage(req({ token }))).toHaveProperty('error', expect.stringContaining('already running'));
  expect(recordPage).not.toHaveBeenCalled();
  expect(appRequest).not.toHaveBeenCalled();
  expect(storage.get(`data-health:${token}`).scanned).toBe(0);
  storage.delete(`data-health-lock:${token}`);
  expect(await handler.checkOrphanPage(req({ token }))).toMatchObject({ found: 1, scanned: 1 });
});

test.each([
  { status: 200, page: { startAt: 0, total: 1, isLast: true, values: [{ id: '123', deleted: true, name: 'PRIVATE PROJECT' }] } },
  { status: 403 }, { status: 500 }, { status: 200, page: {} },
  { status: 200, page: { startAt: 0, total: 0, values: [], isLast: false, nextPage: 'next' } },
  { status: 'transport' },
])('missing issues are not orphaned when project trash cannot be excluded: %j', async ({ status, page }) => {
  healthRecords();
  const original = userRequest.getMockImplementation();
  userRequest.mockImplementation(async (path) => {
    if (!path.startsWith('/rest/api/3/project/search?')) return original(path);
    if (status === 'transport') throw new Error('PRIVATE PROJECT');
    return response(status, page);
  });
  const { page: summary } = await healthScan();
  expect(summary).toMatchObject({ found: 0, scanned: 2, unknown: 2, scanComplete: true });
  expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|deleted|123/);
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});

test('removal re-checks project trash after confirmation and retains all candidates when a project was trashed', async () => {
  const { records } = healthRecords();
  const { token, page } = await healthScan();
  expect(page.found).toBe(2);
  const original = userRequest.getMockImplementation();
  userRequest.mockImplementation(async (path) => path.startsWith('/rest/api/3/project/search?')
    ? response(200, { startAt: 0, total: 1, isLast: true, values: [{ id: '123', deleted: true }] }) : original(path));
  await removeHealth(token, 2);
  expect(await removeHealth(token, 2)).toMatchObject({ removed: 0, retained: 2, removeComplete: true });
  expect(records.size).toBe(2);
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});

test('review tickets issued before trash protection cannot display or remove old candidates', async () => {
  healthRecords();
  const { token } = await healthScan();
  delete storage.get(`data-health:${token}`).policyVersion;
  expect(await handler.checkOrphanPage(req({ token }))).toHaveProperty('error', expect.stringContaining('Trash protection changed'));
  expect(await removeHealth(token, 2)).toHaveProperty('error', expect.stringContaining('Trash protection changed'));
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});
