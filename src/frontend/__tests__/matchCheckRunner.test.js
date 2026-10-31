import { runMatchCheck } from '../matchCheckRunner';

const evidence = { applicable: true, strong: [], relatedRevision: [], otherRelated: [] };
test('20 sequential calls compare evidence independently of elapsedMs and compute timing stats', async () => {
  let count = 0;
  const invoke = jest.fn(async () => ({ ...evidence, elapsedMs: ++count }));
  const result = await runMatchCheck({ invoke });
  expect(invoke).toHaveBeenCalledTimes(20);
  expect(invoke).toHaveBeenCalledWith('findMatches');
  expect(result).toMatchObject({ identical: true, min: 1, median: 10.5, max: 20 });
});
test('detects changed evidence', async () => {
  let count = 0;
  const result = await runMatchCheck({ invoke: async () => ({ ...evidence, elapsedMs: 1,
    strong: ++count === 20 ? [{ key: 'QL-2' }] : [] }) });
  expect(result.identical).toBe(false);
});
test('cancellation stops calls and errors cannot be reported as identical results', async () => {
  const invoke = jest.fn();
  expect(await runMatchCheck({ invoke, cancelled: () => true })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  await expect(runMatchCheck({ invoke: async () => ({ error: 'Unavailable' }) })).rejects.toThrow('Unavailable');
});
