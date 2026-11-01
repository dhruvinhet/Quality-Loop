const { recordReferences, recordsForIssues, visibleRecords } = require('../cleanup');
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
test('visibility deduplicates IDs and requires both NC and CAPA browse access', async () => {
  const getIssue = jest.fn(async (id) => response({ '10': 200, '20': 200, '11': 403, '120': 404 }[id]));
  expect(await visibleRecords(records, getIssue)).toEqual(records.slice(0, 2));
  expect(getIssue).toHaveBeenCalledTimes(4);
});

test.each([403, 404])('HTTP %s cannot expose records or select them for deletion', async (status) => {
  expect(await visibleRecords(records, async () => response(status))).toEqual([]);
});

test.each([401, 429, 500, 503])('HTTP %s returns an error rather than a fabricated empty result', async (status) => {
  await expect(visibleRecords(records, async () => response(status))).rejects.toThrow('Issue access could not be checked.');
});

test('network errors propagate to the safe resolver error boundary', async () => {
  await expect(visibleRecords(records, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
});

test('malformed or incomplete references are never considered authorised', async () => {
  expect(await visibleRecords([{ entity: 'decision', key: 'bad', value: { issueId: '10' } }], async () => response(200))).toEqual([]);
});
