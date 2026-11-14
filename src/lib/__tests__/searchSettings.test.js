const { buildCapture } = require('../capture');
const { matchCaptures, windowStart } = require('../match');
const { buildMatchJql, buildOtherRelatedJql } = require('../matchJql');
const { buildHintJql } = require('../hintJql');
const { selectHints } = require('../hints');
const { defaultSearchSettings, validSearchSettings, listedProjectKeys, LOOKBACK_OPTIONS } = require('../searchSettings');
const nc = { ...buildCapture({ recordType: 'NC', partNumber: 'DEMO-5520-A', failureMode: 'FM-07',
  supplier: 'Demo', detectedDate: '2026-11-14' }), projectId: '100' };
const capa = (days, projectId = '100') => ({ ...nc, id: '2', key: 'DEMO-2', recordType: 'CAPA', projectId,
  closedDate: new Date(Date.parse(nc.detectedDate) - days * 86400000).toISOString().slice(0, 10) });

test('defaults are local project and 365 days; allowed windows are deliberately bounded', () => {
  expect(defaultSearchSettings()).toEqual({ version: 0, scope: 'PROJECT', lookbackDays: 365, projectIds: [], revisionPreset: 'LETTERS' });
  for (const lookbackDays of LOOKBACK_OPTIONS) expect(validSearchSettings({ ...defaultSearchSettings(), lookbackDays })).toBe(true);
  expect(validSearchSettings({ ...defaultSearchSettings(), lookbackDays: 400 })).toBe(false);
});
test.each(LOOKBACK_OPTIONS)('all scope/window JQL paths apply %i days with escaped project values', (days) => {
  for (const ids of [['100'], ['100', '200'], undefined]) {
    const prefix = ids ? `project in (${ids.map((id) => `"${id}"`).join(', ')}) AND ` : '';
    const queries = [buildMatchJql(nc, days, ids), ...buildOtherRelatedJql(nc, days, ids), ...buildHintJql(nc, days, ids)];
    expect(queries).toHaveLength(6);
    expect(queries.every((jql) => jql.startsWith(prefix))).toBe(true);
    expect(queries.filter((jql) => jql.includes(windowStart(nc.detectedDate, days)))).toHaveLength(5);
    if (!ids) expect(queries.every((jql) => !jql.includes('project in'))).toBe(true);
  }
  expect(buildMatchJql(nc, days, ['A" OR project != 1'])).toContain('project in ("A\\" OR project != 1")');
});
test.each(LOOKBACK_OPTIONS)('in-memory matching and hint reasons share the %i-day window', (days) => {
  expect(matchCaptures(nc, [capa(days)], days, ['100']).strong).toHaveLength(1);
  expect(matchCaptures(nc, [capa(days + 1)], days, ['100']).strong).toHaveLength(0);
  expect(selectHints(nc, [capa(days + 1)], days, ['100'])[0].reason).toContain(`outside the ${days}-day window`);
  expect(selectHints(nc, [capa(days)], days, ['100'])).toEqual([]);
});
test('a 400-day CAPA is a hint at 365 and a strong match at 730; same-project scope excludes other DEMO projects', () => {
  expect(matchCaptures(nc, [capa(400)], 365, ['100']).strong).toEqual([]);
  expect(matchCaptures(nc, [capa(400)], 730, ['100']).strong).toHaveLength(1);
  expect(matchCaptures(nc, [capa(30, '200')], 365, ['100']).strong).toEqual([]);
  expect(selectHints(nc, [capa(400, '200')], 365, ['100'])).toEqual([]);
  expect(matchCaptures(nc, [capa(30, '200')], 365, ['100', '200']).strong).toHaveLength(1);
  expect(matchCaptures(nc, [capa(30, '200')], 365).strong).toHaveLength(1);
});
test('listed keys normalize without admitting query/path syntax or unbounded lists', () => {
  expect(listedProjectKeys(' qa, OPS qa ')).toEqual(['QA', 'OPS']);
  for (const value of ['QA/../SECRET', 'QA" OR project=1', null, Array.from({ length: 21 }, (_, i) => `P${i}`).join(',')]) {
    expect(() => listedProjectKeys(value)).toThrow();
  }
});
