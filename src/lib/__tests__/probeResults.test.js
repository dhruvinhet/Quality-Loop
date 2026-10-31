import { summarise, formatResults } from '../probeResults';

test('computes even/odd medians, excludes pending/errors and counts misses separately', () => {
  expect(summarise([{ searchHitMs: 3000 }, { searchHitMs: 'miss' }, { searchHitMs: 1000 },
    { searchHitMs: 'error', error: 'failed' }, { searchHitMs: null }])).toEqual({
    min: 1000, median: 2000, max: 3000, misses: 1, errors: 1,
  });
  expect(summarise([1000, 2000, 3000].map((searchHitMs) => ({ searchHitMs })))).toHaveProperty('median', 2000);
  expect(summarise([{ searchHitMs: 'miss' }])).toMatchObject({ min: null, median: null, max: null, misses: 1 });
});

test('exports plain text with timing definitions, token, readback, and summary', () => {
  const text = formatResults([{ run: 1, token: 'E1-1793400000000-1', writeMs: 52, readbackOk: false, searchHitMs: 'miss' }]);
  expect(text).toContain('1\tE1-1793400000000-1\t52\tfalse\tmiss');
  expect(text).toContain('misses: 1');
});
