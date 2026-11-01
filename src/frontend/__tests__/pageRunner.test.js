const { callPage, pollSampleReady, scanRecordPages } = require('../pageRunner');

test('page bridge failures cannot expose raw exceptions', async () => {
  await expect(callPage(jest.fn().mockRejectedValue(new Error('SECRET issue details')), 'sampleStatus'))
    .rejects.toThrow('The response could not be read. Refresh the page and check Jira before retrying.');
});

test('readiness polls every two seconds until ready', async () => {
  let time = 0;
  const sleep = jest.fn(async (ms) => { time += ms; });
  const check = jest.fn().mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: false })
    .mockResolvedValue({ ready: true, newNcKey: 'DEMO-5' });
  expect(await pollSampleReady(check, { now: () => time, sleep })).toEqual({ ready: true, newNcKey: 'DEMO-5' });
  expect(sleep.mock.calls).toEqual([[2000], [2000]]);
});
test('readiness stops at thirty seconds without extending the deadline for slow requests', async () => {
  let time = 0;
  const check = jest.fn(async () => { time += 500; return { ready: false }; });
  expect(await pollSampleReady(check, { now: () => time, sleep: async (ms) => { time += ms; } })).toEqual({ ready: false });
  expect(time).toBeLessThanOrEqual(30500);
});
test('record pagination follows an empty page cursor and both entities', async () => {
  const visit = jest.fn().mockResolvedValueOnce({ nextCursor: 'next' }).mockResolvedValue({});
  await scanRecordPages(visit);
  expect(visit.mock.calls).toEqual([['decision', undefined], ['decision', 'next'], ['pair-state', undefined]]);
});
