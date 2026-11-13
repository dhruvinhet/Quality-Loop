const { FAILURE_MODES } = require('../../config/failureModes');
const { seedCatalogue, validCatalogue, changeCatalogue, modeOptions, failureModeLabel } = require('../failureModes');
const { buildCapture, validateCapture } = require('../capture');
const { matchCaptures } = require('../match');

test('the single default seed follows the documented eval plant story with stable codes', () => {
  expect(FAILURE_MODES.map(({ code, label }) => [code, label])).toEqual([
    ['FM-01', 'Crack'], ['FM-02', 'Burr'], ['FM-03', 'Dimension out of tolerance'], ['FM-04', 'Porosity'],
    ['FM-05', 'Corrosion'], ['FM-06', 'Missing feature'], ['FM-07', 'Surface damage'], ['FM-99', 'Other'],
  ]);
  expect(validCatalogue(seedCatalogue())).toBe(true);
});
test('a custom canonical code validates, round-trips, and produces a strong match', () => {
  const catalogue = changeCatalogue(seedCatalogue(), { action: 'add', code: ' fm-08 ', label: 'Wire fracture' });
  const nc = { recordType: 'NC', partNumber: 'P-1-A', failureMode: ' fm-08 ', detectedDate: '2026-11-13' };
  const capa = { ...nc, recordType: 'CAPA', closedDate: '2026-11-12' };
  expect(validateCapture(nc, catalogue.modes)).toEqual({});
  expect(buildCapture(nc).failureMode).toBe('FM-08');
  expect(matchCaptures(buildCapture(nc), [{ ...buildCapture(capa), id: '2' }]).strong).toHaveLength(1);
  expect(modeOptions(catalogue.modes)).toContainEqual({ value: 'FM-08', label: 'FM-08 Wire fracture' });
});
test('deactivation retains codes; active options and validation exclude them', () => {
  const original = seedCatalogue();
  const changed = changeCatalogue(original, { action: 'deactivate', code: 'FM-01' });
  expect(changed.modes).toHaveLength(original.modes.length);
  expect(failureModeLabel('FM-01', changed.modes)).toBe('FM-01');
  expect(modeOptions(changed.modes).some(({ value }) => value === 'FM-01')).toBe(false);
  expect(validateCapture({ recordType: 'NC', partNumber: 'P-1', failureMode: 'FM-01', detectedDate: '2026-11-13' }, changed.modes))
    .toHaveProperty('failureMode');
  expect(() => changeCatalogue(changed, { action: 'add', code: 'fm-01', label: 'Reuse' })).toThrow(/already exists/);
  expect(() => changeCatalogue(changed, { action: 'delete', code: 'FM-01' })).toThrow(/cannot be deleted/);
  expect(original.modes[0].active).toBe(true);
  expect(changeCatalogue(changed, { action: 'activate', code: 'FM-01' }).modes[0].active).toBe(true);
});
test('rename changes only the label and revision, not codes or active state', () => {
  const catalogue = seedCatalogue();
  expect(changeCatalogue(catalogue, { action: 'rename', code: 'FM-01', label: 'Hairline crack' }))
    .toEqual({ version: 1, modes: catalogue.modes.map((m) => m.code === 'FM-01' ? { ...m, label: 'Hairline crack' } : m) });
});
test.each(['', '-FM', 'FM 08', 'A'.repeat(33), 'FM"08', null])('invalid code %j cannot enter the catalogue', (code) => {
  expect(() => changeCatalogue(seedCatalogue(), { action: 'add', code, label: 'Test' })).toThrow(/Use a code/);
});
test('all 50 slots include inactive codes; invalid labels and corrupt catalogues are rejected', () => {
  const modes = Array.from({ length: 50 }, (_, i) => ({ code: `MODE_${i}`, label: 'Test', active: false }));
  expect(() => changeCatalogue({ version: 1, modes }, { action: 'add', code: 'EXTRA', label: 'Test' })).toThrow(/50/);
  expect(() => changeCatalogue(seedCatalogue(), { action: 'rename', code: 'FM-01', label: ' ' })).toThrow(/label/);
  for (const invalid of [null, {}, { version: 1, modes: [null] }, { version: 1, modes: [modes[0], modes[0]] }]) {
    expect(validCatalogue(invalid)).toBe(false);
  }
});
