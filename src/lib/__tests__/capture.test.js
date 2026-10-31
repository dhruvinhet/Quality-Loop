import { buildCapture, validateCapture, validDate } from '../capture';

const nc = { recordType: 'NC', partNumber: ' p-4471 -a ', failureMode: 'FM-01', detectedDate: '2026-10-31' };

test('requires NC detected date and rejects invalid selections or whitespace-only part', () => {
  expect(validateCapture({ recordType: '', partNumber: '  ', failureMode: 'FM-00' })).toHaveProperty('recordType');
  expect(validateCapture({ ...nc, detectedDate: '' })).toHaveProperty('detectedDate');
  expect(validateCapture(nc)).toEqual({});
});

test('validates real calendar dates', () => {
  expect(validDate('2024-02-29')).toBe(true);
  expect(validDate('2025-02-29')).toBe(false);
  expect(validDate('2026-04-31')).toBe(false);
  expect(validDate('31/10/2026')).toBe(false);
});

test('CAPA dates and evidence are optional, but a supplied link must be http(s)', () => {
  expect(validateCapture({ ...nc, recordType: 'CAPA', detectedDate: '' })).toEqual({});
  expect(validateCapture({ ...nc, recordType: 'CAPA', effectivenessEvidenceUrl: 'javascript:alert(1)' })).toHaveProperty('effectivenessEvidenceUrl');
  expect(validateCapture({ ...nc, recordType: 'CAPA', effectivenessEvidenceUrl: 'https://example.com/evidence' })).toEqual({});
});

test('builds the versioned property, preserves original, and clears CAPA-only fields for NC', () => {
  const input = Object.freeze({ ...nc, closedDate: '2026-10-30', effectivenessEvidenceUrl: 'https://example.com' });
  expect(buildCapture(input, '2026-10-31T00:00:00.000Z')).toEqual({
    schemaVersion: 1, recordType: 'NC', partOriginal: nc.partNumber,
    partNorm: 'P-4471 -A', partBase: 'P-4471 ', partRevision: 'A',
    failureMode: 'FM-01', supplier: '', line: '', detectedDate: '2026-10-31',
    closedDate: null, effectivenessEvidenceUrl: '', updatedAt: '2026-10-31T00:00:00.000Z',
  });
});
