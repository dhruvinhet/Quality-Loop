import { buildCapture } from '../capture';
import { matchCaptures } from '../match';
import { buildHintJql } from '../hintJql';
import { compactPart, differsByAtMostOneEdit, excludeMatchedHints, selectHints } from '../hints';

const nc = { ...buildCapture({ recordType: 'NC', partNumber: 'P-5120-A',
  failureMode: 'FM-01', detectedDate: '2026-10-31' }), id: '1', key: 'QL-1' };
const capa = (id, overrides = {}) => ({ ...buildCapture({ recordType: 'CAPA',
  partNumber: 'P-5120-A', failureMode: 'FM-01', closedDate: '2026-10-01', ...overrides }),
  id, key: `QL-${id}` });

test.each([
  ['P-5210-A', 'P-5120-A', true], // adjacent transposition
  ['SM-6604 -A', 'sm-6604-a', true], // compact equality
  ['ABC', 'AB', true], ['AB', 'ABC', true], ['ABC', 'AXC', true],
  ['ABC', 'ACB', true], ['ABC', 'ABC', true], ['ABC', 'AXY', false],
  ['ABC', 'CBA', false], ['ABC', 'ABCDE', false],
])('compacted one-edit threshold: %s / %s', (left, right, expected) => {
  expect(differsByAtMostOneEdit(compactPart(left), compactPart(right))).toBe(expected);
});

test('transposition and stray space are hints without changing any match class or originals', () => {
  const candidate = Object.freeze(capa('2', { partNumber: ' p-5210-a ', failureMode: ' fm-01 ' }));
  const current = Object.freeze({ ...nc });
  const before = matchCaptures(current, [candidate]);
  expect(selectHints(current, [candidate])).toEqual([expect.objectContaining({
    id: '2', partOriginal: ' p-5210-a ', failureMode: ' fm-01 ', reason: 'Part number differs only slightly',
  })]);
  expect(matchCaptures(current, [candidate])).toEqual(before);
  expect(before.strong).toEqual([]);
  expect(before.relatedRevision).toEqual([]);
  const space = capa('3', { partNumber: 'SM-6604 -A' });
  expect(selectHints({ ...nc, partOriginal: 'SM-6604-A' }, [space])[0].reason).toBe('Part number differs only slightly');
  expect(space.partOriginal).toBe('SM-6604 -A');
});

test('same base/revision differences and existing strong matches are never hints', () => {
  const candidates = [capa('2'), capa('3', { partNumber: 'P-5120-B' }),
    capa('4', { partNumber: 'P-5120-AA' }), capa('5', { partNumber: 'P-5120' })];
  const matches = matchCaptures(nc, candidates);
  expect(matches.strong).toHaveLength(1);
  expect(matches.relatedRevision).toHaveLength(3);
  expect(selectHints(nc, candidates)).toEqual([]);
  for (const closedDate of [null, '2025-10-30']) {
    expect(selectHints(nc, [capa('3', { partNumber: 'P-5120-B', closedDate })])).toEqual([]);
  }
});

test('exclude matches by id or key across separately refreshed match/hint snapshots', () => {
  const hints = [capa('2'), capa('3'), capa('4')];
  expect(excludeMatchedHints(hints, { strong: [{ id: 2 }], relatedRevision: [{ key: 'QL-3' }] }))
    .toEqual([hints[2]]);
  expect(excludeMatchedHints(hints, { otherRelated: hints })).toEqual(hints);
});

test('at most three unique hints, priority slight part, missing date, older; oldest category is most recent first', () => {
  const candidates = [capa('2', { closedDate: '2024-01-01' }),
    capa('3', { closedDate: '2025-10-30' }), capa('4', { closedDate: null }),
    capa('5', { partNumber: 'P-5210-A' })];
  const selected = selectHints(nc, [...candidates, candidates[3]]);
  expect(selected.map(({ id }) => id)).toEqual(['5', '4', '3']);
  expect(selected.map(({ reason }) => reason)).toEqual([
    'Part number differs only slightly', 'No closed date recorded', 'Older precedent',
  ]);
  expect(selectHints(nc, [...candidates].reverse())).toEqual(selected);
  expect(selectHints(nc, candidates.slice(0, 2)).map(({ id }) => id)).toEqual(['3', '2']);
});

test.each([undefined, null, ''])('absent closed value %j qualifies regardless of Jira status', (closedDate) => {
  const candidate = { ...capa('2'), closedDate, status: 'In Progress' };
  expect(selectHints(nc, [candidate])[0].reason).toBe('No closed date recorded');
});

test.each([
  ['2026-10-31', false], ['2026-10-30', true], ['2025-10-31', true],
  ['2025-10-30', false], ['2026-11-01', false], [null, false], ['2026-02-30', false],
])('slight part uses the normal 1–365 day window: %j', (closedDate, eligible) => {
  expect(selectHints(nc, [capa('2', { partNumber: 'P-5210-A', closedDate })])).toHaveLength(eligible ? 1 : 0);
});

test('older precedent strictly exceeds 365 days and preserves original signature strings', () => {
  const candidates = [capa('2', { closedDate: '2025-10-31' }),
    capa('3', { partNumber: ' p-5120-a ', failureMode: ' fm-01 ', closedDate: '2025-10-30' })];
  expect(selectHints(nc, candidates)).toEqual([expect.objectContaining({
    id: '3', reason: 'Older precedent', partOriginal: ' p-5120-a ', failureMode: ' fm-01 ',
  })]);
});

test('same-mode/supplier otherRelated may be a hint but never enters the decision match classes', () => {
  const current = { ...nc, supplier: 'S1' };
  const candidates = [capa('2', { partNumber: 'P-5210-A', supplier: 'S1' })];
  expect(matchCaptures(current, candidates).otherRelated).toHaveLength(1);
  expect(selectHints(current, candidates)).toHaveLength(1);
  expect(matchCaptures(current, candidates).strong).toEqual([]);
});

test('malformed, self, non-CAPA, blank/different mode, invalid dates and distant parts do not leak into hints', () => {
  const candidates = [null, capa('1', { closedDate: null }), { ...capa('2', { closedDate: null }), key: 'QL-1' },
    capa('3', { recordType: 'NC', closedDate: null }), capa('4', { failureMode: 'FM-02', closedDate: null }),
    capa('5', { partNumber: ' ', closedDate: null }), capa('6', { closedDate: 'not-a-date' }),
    capa('7', { partNumber: 'P-9999-A' }), capa('8', { partNumber: 'P-5210-A', closedDate: '' }),
    capa('9', { closedDate: ' ' })];
  expect(selectHints(nc, candidates)).toEqual([]);
  for (const current of [null, { ...nc, recordType: 'CAPA' }, { ...nc, detectedDate: null },
    { ...nc, failureMode: ' ' }, { ...nc, partOriginal: '' }]) expect(selectHints(current, [capa('2')])).toEqual([]);
});

test('JQL candidate searches are bounded, use strict date limits and avoid undocumented EMPTY', () => {
  expect(buildHintJql(nc)).toEqual([
    'qlRecordType = "CAPA" AND qlClosed >= "2025-10-31" AND qlClosed < "2026-10-31" ORDER BY qlClosed DESC, key ASC',
    'qlRecordType = "CAPA" AND qlPart = "P-5120-A" ORDER BY key ASC',
    'qlRecordType = "CAPA" AND qlPart = "P-5120-A" AND qlClosed < "2025-10-31" ORDER BY qlClosed DESC, key ASC',
  ]);
  expect(buildHintJql({ ...nc, partOriginal: 'A" OR issue != 1' })[1]).toContain('qlPart = "A\\" OR ISSUE != 1"');
});
