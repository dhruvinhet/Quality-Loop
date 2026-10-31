import { runProbes } from '../probeRunner';

function harness(searchHit = true) {
  let clock = 1793400000000;
  const rows = new Map();
  const invoke = jest.fn(async (name) => {
    if (name === 'probeWrite') return { writeMs: 20 };
    if (name === 'probeRead') return { readbackOk: true };
    return { hit: searchHit };
  });
  const settings = {
    invoke, now: () => clock,
    wait: async (ms) => { clock += ms; },
    cancelled: () => false,
    onRow: (row) => rows.set(row.run, row),
  };
  return { settings, rows, invoke };
}

test('runs exactly 20 sequential write/read/search runs, publishing live rows', async () => {
  const { settings, rows, invoke } = harness();
  const updates = jest.fn(settings.onRow);
  await runProbes({ ...settings, onRow: updates });
  expect(rows.size).toBe(20);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(Array.from({ length: 20 }, () => ['probeWrite', 'probeRead', 'probeSearch']).flat());
  expect(rows.get(1)).toMatchObject({ token: 'E1-1793400000000-1', readbackOk: true, searchHitMs: 1000 });
  expect(updates.mock.calls[0][0].searchHitMs).toBeNull();
  expect(rows.get(20).token).toMatch(/-20$/);
});

test('polls at 1 s and marks a miss at the 60 s deadline, including all-miss runs', async () => {
  const { settings, rows, invoke } = harness(false);
  const wait = jest.fn(settings.wait);
  await runProbes({ ...settings, wait });
  expect([...rows.values()].every((row) => row.searchHitMs === 'miss')).toBe(true);
  expect(wait).toHaveBeenCalledTimes(60 * 20);
  expect(wait.mock.calls.every(([ms]) => ms === 1000)).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name === 'probeSearch')).toHaveLength(59 * 20);
});

test('reports API errors separately and continues the remaining sequential runs', async () => {
  const { settings, rows, invoke } = harness();
  invoke.mockResolvedValueOnce({ error: 'Rate limited.' });
  await runProbes(settings);
  expect(rows.get(1)).toMatchObject({ searchHitMs: 'error', error: 'Rate limited.' });
  expect(rows.get(2)).toHaveProperty('searchHitMs', 1000);
});

test('records false readback while still measuring index visibility', async () => {
  const { settings, rows, invoke } = harness();
  invoke.mockImplementation(async (name) => name === 'probeWrite' ? { writeMs: 20 } : name === 'probeRead' ? { readbackOk: false } : { hit: true });
  await runProbes(settings);
  expect(rows.get(1)).toMatchObject({ readbackOk: false, searchHitMs: 1000 });
});

test('does not issue additional requests when the panel unmounts', async () => {
  const { settings, invoke } = harness();
  let cancelled = false;
  invoke.mockImplementation(async () => { cancelled = true; return { writeMs: 20 }; });
  await runProbes({ ...settings, cancelled: () => cancelled });
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('marks an in-flight timeout as a miss and drains it before starting another run', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(1793400000000);
  let release;
  let cancelled = false;
  const rows = new Map();
  const invoke = jest.fn(async (name) => {
    if (name === 'probeWrite') return { writeMs: 20 };
    if (name === 'probeRead') return { readbackOk: true };
    return new Promise((resolve) => { release = resolve; });
  });
  try {
    const pending = runProbes({ invoke, cancelled: () => cancelled, onRow: (row) => rows.set(row.run, row) });
    await jest.advanceTimersByTimeAsync(60000);
    expect(rows.get(1).searchHitMs).toBe('miss');
    expect(invoke).toHaveBeenCalledTimes(3);
    cancelled = true;
    release({ hit: true });
    await pending;
    expect(invoke).toHaveBeenCalledTimes(3);
  } finally {
    jest.useRealTimers();
  }
});
