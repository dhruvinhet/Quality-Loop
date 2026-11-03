jest.mock('@forge/api', () => ({ __esModule: true, default: { asApp: jest.fn(), asUser: jest.fn() },
  route: (parts, ...values) => parts.reduce((text, part, i) => text + part + (values[i] ?? ''), '') }));
jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn(), set: jest.fn(), entity: jest.fn() } }));
jest.mock('../cleanupStore', () => ({ recordPage: jest.fn(), deleteRecordBatch: jest.fn() }));
const { kvs } = require('@forge/kvs');
const api = require('@forge/api').default;
const { recordPage, deleteRecordBatch } = require('../cleanupStore');
const { initialHealth, scanHealthPage, removeHealthPage } = require('../dataHealthStore');
const { loadBudget } = require('../loadBudget');
let rows, stored, request;
beforeEach(() => {
  jest.clearAllMocks();
  rows = Array.from({ length: 3 }, (_, i) => ({ entity: 'decision', key: `r${i}`, value: { issueId: String(10 + i), capaId: '20' } }));
  stored = new Map();
  kvs.set.mockImplementation(async (key, value) => stored.set(key, JSON.parse(JSON.stringify(value))));
  kvs.get.mockImplementation(async (key) => stored.get(key));
  kvs.entity.mockReturnValue({ get: async (key) => rows.find((row) => row.key === key)?.value });
  recordPage.mockResolvedValue({ records: rows });
  request = jest.fn(async () => ({ status: 404 }));
  api.asApp.mockReturnValue({ requestJira: request });
  api.asUser.mockReturnValue({ requestJira: jest.fn(async () => ({ status: 200,
    json: async () => ({ startAt: 0, total: 0, isLast: true, values: [] }) })) });
  deleteRecordBatch.mockResolvedValue();
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('scan budget expiry checkpoints unfinished records and resumes without double-counting', async () => {
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  request.mockImplementation(async () => {
    if (request.mock.calls.length === 3) clock = 12001;
    return { status: 404 };
  });
  const state = initialHealth();
  expect(await scanHealthPage('token', state)).toMatchObject({ paused: true });
  expect(state).toMatchObject({ found: 1, scanned: 1, pending: [{ key: 'r1' }, { key: 'r2' }] });
  expect(stored.get('data-health-batch:token:0').records.map(({ key }) => key)).toEqual(['r0']);
  clock = 0;
  request.mockImplementation(async () => ({ status: 404 }));
  const resumed = JSON.parse(JSON.stringify(state));
  await scanHealthPage('token', resumed);
  expect(resumed).toMatchObject({ found: 3, scanned: 3, entityIndex: 1 });
  expect(recordPage).toHaveBeenCalledTimes(1);
});

test('removal budget resumes remaining confirmed records and re-checks the unfinished record', async () => {
  const state = initialHealth();
  await scanHealthPage('token', state);
  state.scanComplete = true;
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  deleteRecordBatch.mockImplementation(async () => { clock = 12001; });
  expect(await removeHealthPage('token', state)).toEqual({ paused: true });
  expect(state.removed).toBe(1);
  expect(state.pendingDelete.map(({ key }) => key)).toEqual(['r1', 'r2']);
  clock = 0;
  deleteRecordBatch.mockResolvedValue();
  request.mockClear();
  await removeHealthPage('token', state);
  expect(state).toMatchObject({ removed: 3, removeComplete: true });
  expect(request).toHaveBeenCalledTimes(4);
  expect(deleteRecordBatch.mock.calls.map(([batch]) => batch[0].key)).toEqual(['r0', 'r1', 'r2']);
});

test('a hanging existence call times out with pending records available for resume', async () => {
  jest.useFakeTimers();
  request.mockImplementation(() => new Promise(() => {}));
  const state = initialHealth();
  const operation = scanHealthPage('token', state, loadBudget(12000));
  await jest.advanceTimersByTimeAsync(12000);
  expect(await operation).toMatchObject({ paused: true });
  expect(state).toMatchObject({ found: 0, scanned: 0 });
  expect(state.pending).toHaveLength(3);
  expect(deleteRecordBatch).not.toHaveBeenCalled();
});
