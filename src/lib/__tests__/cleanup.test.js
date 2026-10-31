const { recordReferences, recordsForIssues, detectOrphans } = require('../cleanup');
const records = [
  { entity: 'decision', key: '20:10:decision', value: { capaId: '20', issueId: '10' } },
  { entity: 'pair-state', key: '20:10', value: { version: 3, state: 'CONFIRMED' } },
  { entity: 'decision', key: '120:11:decision', value: { capaId: '120', issueId: '11' } },
  { entity: 'pair-state', key: '120:11', value: { capaId: '120', issueId: '11' } },
];
test('cleanup selects either side with exact ID equality, including legacy pairs', () => {
  expect(recordsForIssues(records, ['10'])).toEqual(records.slice(0, 2));
  expect(recordsForIssues(records, ['20'])).toEqual(records.slice(0, 2));
  expect(recordsForIssues(records, ['1'])).toEqual([]);
  expect(recordsForIssues(records, ['10', '20'])).toHaveLength(2);
  expect(recordReferences('pair-state', 'bad-key', {})).toEqual([]);
  expect(recordReferences('pair-state', '20:10', { capaId: '999', issueId: '888' })).toEqual(['10', '20']);
});
const response = (status) => ({ status, ok: status >= 200 && status < 300 });
test('orphan detection deduplicates IDs and selects only explicit 404 responses', async () => {
  const getIssue = jest.fn(async (id) => response({ '10': 200, '20': 404, '11': 403, '120': 500 }[id]));
  const result = await detectOrphans(records, getIssue);
  expect(result.records).toEqual(records.slice(0, 2));
  expect(result.missingIds).toEqual(['20']);
  expect(result.unknownIds).toEqual(['11', '120']);
  expect(getIssue).toHaveBeenCalledTimes(4);
});
test.each([401, 403, 429, 500, 503])('HTTP %s must not select app records for deletion', async (status) => {
  const result = await detectOrphans(records, async () => response(status));
  expect(result.records).toEqual([]);
  expect(result.missingIds).toEqual([]);
});
test('network errors are unresolved, not missing issues', async () => {
  const result = await detectOrphans(records, async () => { throw new Error('offline'); });
  expect(result.records).toEqual([]);
  expect(result.unknownIds).toHaveLength(4);
});
