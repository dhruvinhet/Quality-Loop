import { runConcurrencyCheck } from '../concurrencyRunner';
test('E8 sends exactly two parallel calls per round with the same version and checks all ten rounds', async () => {
  let version = 0;
  let pending = [];
  const calls = [];
  const invoke = jest.fn(async (name, payload) => {
    if (name === 'e8PairState') return { pairState: { version } };
    calls.push(payload);
    return new Promise((resolve) => {
      pending.push(resolve);
      if (pending.length === 2) {
        version += 1;
        pending[0]({ success: true, pairState: { version } });
        pending[1]({ conflict: true, pairState: { version } });
        pending = [];
      }
    });
  });
  const result = await runConcurrencyCheck({ invoke, capaId: '20002' });
  expect(result).toMatchObject({ pass: true, successfulWrites: 10, conflicts: 10, version: 10 });
  for (let round = 0; round < 10; round += 1) {
    expect(calls[round * 2]).toEqual(calls[round * 2 + 1]);
    expect(calls[round * 2].expectedVersion).toBe(round);
  }
});
test('E8 does not label double success as passing', async () => {
  let version = 0;
  const invoke = async (name) => name === 'e8PairState' ? { pairState: { version } } : (version += 1, { success: true });
  const result = await runConcurrencyCheck({ invoke, capaId: '20002' });
  expect(result.pass).toBe(false);
  expect(result.successfulWrites).toBe(20);
  expect(result.conflicts).toBe(0);
});
test('E8 includes prior committed writes when verifying a pair with existing history', async () => {
  let version = 4;
  const invoke = async (name, payload) => {
    if (name === 'e8PairState') return { pairState: { version } };
    if (payload.expectedVersion === version) { version += 1; return { success: true }; }
    return { conflict: true };
  };
  expect(await runConcurrencyCheck({ invoke, capaId: '20002' })).toMatchObject({ pass: true,
    startingVersion: 4, successfulWrites: 10, totalSuccessfulWrites: 14, conflicts: 10, version: 14 });
});
test('closing the E8 card stops subsequent writes', async () => {
  let closed = false;
  let version = 0;
  const invoke = jest.fn(async (name) => {
    if (name === 'e8PairState') return { pairState: { version } };
    version += 1;
    return { success: true };
  });
  await expect(runConcurrencyCheck({ invoke, capaId: '20002', cancelled: () => closed,
    onRound: () => { closed = true; } })).rejects.toThrow('card was closed');
  expect(invoke.mock.calls.filter(([name]) => name === 'recordDecision')).toHaveLength(2);
});
