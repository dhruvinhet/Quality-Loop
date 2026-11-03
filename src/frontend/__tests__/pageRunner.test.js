const { callPage, pollSampleReady, scanRecordPages, runHealthPages } = require('../pageRunner');

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

test('health runner reports cumulative progress and bounds each browser action', async () => {
  const visit = jest.fn().mockResolvedValue({ scanComplete: false });
  const progress = jest.fn();
  await runHealthPages(visit, 'scanComplete', progress, 3);
  expect(visit).toHaveBeenCalledTimes(3);
  expect(progress).toHaveBeenCalledTimes(3);
});

test.each([{ paused: true }, { scanComplete: true }])('health runner stops for budget/complete result %j', async (result) => {
  const visit = jest.fn().mockResolvedValue(result);
  expect(await runHealthPages(visit, 'scanComplete', jest.fn())).toEqual(result);
  expect(visit).toHaveBeenCalledTimes(1);
});
