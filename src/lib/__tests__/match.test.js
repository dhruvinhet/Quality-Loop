import { buildCapture } from '../capture';
import { matchCaptures, windowStart } from '../match';
import { buildMatchJql, escapeJqlValue } from '../matchJql';

const nc = { ...buildCapture({ recordType: 'NC', partNumber: ' p-4471-a ', failureMode: 'FM-01',
  supplier: 'Supplier 1', line: 'Line 1', detectedDate: '2026-10-31' }), id: '1', key: 'QL-1' };
const capa = (overrides = {}, metadata = {}) => ({
  ...buildCapture({ recordType: 'CAPA', partNumber: 'P-4471-A', failureMode: 'FM-01',
    supplier: 'Supplier 1', line: 'Line 1', closedDate: '2026-10-01', ...overrides }),
  id: '2', key: 'QL-2', summary: 'Evidence', status: 'Done', ...metadata,
});
const classify = (candidate) => matchCaptures(nc, [candidate]);

test('strong exact with elapsed days and listed supporting facts', () => {
  expect(classify(capa()).strong[0]).toMatchObject({ daysSinceClosure: 30,
    supportingFacts: ['Same supplier: Supplier 1', 'Same line: Line 1'] });
});
test('spacing and case only differences are strong and preserve original', () => {
  const current = { ...nc, partOriginal: ' bracket  4471-a ' };
  const original = 'BRACKET   4471-A';
  expect(matchCaptures(current, [capa({ partNumber: original })]).strong[0].partOriginal).toBe(original);
});
test('different revision is relatedRevision, never strong', () => {
  const result = classify(capa({ partNumber: 'P-4471-B' }));
  expect(result.strong).toEqual([]);
  expect(result.relatedRevision).toHaveLength(1);
});
test('same part and different failure mode is otherRelated', () => {
  expect(classify(capa({ failureMode: 'FM-02' })).otherRelated).toHaveLength(1);
});
test('same failure mode and supplier with a different base is otherRelated', () => {
  expect(classify(capa({ partNumber: 'P-9999-A' })).otherRelated).toHaveLength(1);
  expect(classify(capa({ partNumber: 'P-9999-A', supplier: 'Another' })).otherRelated).toEqual([]);
});
test.each([
  ['closed after detection', { closedDate: '2026-11-01' }, {}],
  ['outside window', { closedDate: '2025-10-30' }, {}],
  ['no closedDate', { closedDate: '' }, {}],
  ['invalid date', { closedDate: '2026-02-30' }, {}],
  ['self by id', {}, { id: '1' }],
  ['self by key', {}, { key: 'QL-1' }],
  ['NC candidate', { recordType: 'NC' }, {}],
])('%s is excluded', (_, fields, metadata) => {
  expect(classify(capa(fields, metadata))).toEqual({ strong: [], relatedRevision: [], otherRelated: [] });
});
test('window bounds are inclusive and a configurable lookback uses UTC calendar days', () => {
  expect(classify(capa({ closedDate: '2025-10-31' })).strong[0].daysSinceClosure).toBe(365);
  expect(classify(capa({ closedDate: nc.detectedDate })).strong[0].daysSinceClosure).toBe(0);
  expect(matchCaptures(nc, [capa()], 29).strong).toEqual([]);
  expect(windowStart('2024-03-01', 1)).toBe('2024-02-29');
});
test('missing supplier and line are not supporting facts', () => {
  expect(matchCaptures({ ...nc, supplier: '', line: '' }, [capa({ supplier: '', line: '' })]).strong[0].supportingFacts).toEqual([]);
});
test('ordering is deterministic: strong class first, closure descending then key', () => {
  const candidates = [capa({}, { id: '3', key: 'QL-3' }), capa({ closedDate: '2026-09-30' }),
    capa({}, { id: '4', key: 'QL-4' }), capa({ partNumber: 'P-4471-B', closedDate: '2026-10-30' }, { id: '5', key: 'QL-5' })];
  const result = matchCaptures(nc, candidates);
  expect(Object.keys(result)).toEqual(['strong', 'relatedRevision', 'otherRelated']);
  expect(result.strong.map(({ key }) => key)).toEqual(['QL-3', 'QL-4', 'QL-2']);
  expect(matchCaptures(nc, [...candidates].reverse())).toEqual(result);
});
test('JQL values escape quotes and backslashes and cannot break out of the literal', () => {
  expect(escapeJqlValue('A"B\\C')).toBe('"A\\"B\\\\C"');
  expect(escapeJqlValue('" OR issue != 1')).toBe('"\\" OR issue != 1"');
  expect(() => escapeJqlValue('bad\nvalue')).toThrow();
  const query = buildMatchJql(nc);
  expect(query).toBe('qlRecordType = "CAPA" AND (qlPartBase = "P-4471" OR qlFailureMode = "FM-01") AND qlClosed <= "2026-10-31" AND qlClosed >= "2025-10-31" ORDER BY qlClosed DESC, key ASC');
});
