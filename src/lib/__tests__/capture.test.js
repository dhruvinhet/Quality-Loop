import { buildCapture, validateCapture, validDate } from '../capture';

const nc = { recordType: 'NC', partNumber: ' p-4471 -a ', failureMode: 'FM-01', detectedDate: '2026-10-31' };

test('schema v3 stores canonical codes and supplier/line norms while preserving originals', () => {
  const input = { ...nc, failureMode: ' fm-01 ', supplier: ' Acme  Parts ', line: ' Cell  a ' };
  expect(validateCapture(input)).toEqual({});
  expect(buildCapture(input)).toMatchObject({ schemaVersion: 3, failureMode: 'FM-01',
    supplier: ' Acme  Parts ', supplierNorm: 'ACME PARTS', line: ' Cell  a ', lineNorm: 'CELL A' });
});

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

test.each([undefined, null, ''])('CAPA requires a closed date when missing: %j', (closedDate) => {
  expect(validateCapture({ ...nc, recordType: 'CAPA', closedDate })).toEqual({
    closedDate: 'Select a closed date for a CAPA. Matching uses this date, not Jira status.',
  });
});

test('CAPA detected date and evidence are optional, but supplied values must be valid', () => {
  const capa = { ...nc, recordType: 'CAPA', closedDate: '2026-10-30', detectedDate: '' };
  expect(validateCapture(capa)).toEqual({});
  expect(validateCapture({ ...capa, closedDate: '2026-02-30' })).toHaveProperty('closedDate');
  expect(validateCapture({ ...capa, effectivenessEvidenceUrl: 'javascript:alert(1)' })).toHaveProperty('effectivenessEvidenceUrl');
  expect(validateCapture({ ...capa, effectivenessEvidenceUrl: 'https://example.com/evidence' })).toEqual({});
});

test.each([
  ['https://user:pass@example.com/x', 'Remove the user name and password from the link.'],
  ['http://example.com/evidence', 'Use an https:// link.'], ['javascript:alert(1)', 'Use an https:// link.'],
  [' https://example.com/evidence', 'Remove spaces before or after the link.'],
  ['https://example.com/evidence ', 'Remove spaces before or after the link.'],
  ['https://', 'Enter a full https:// link.'], ['https:///report.pdf', 'Enter a full https:// link.'],
  ['https://example.com/a\nb', 'Enter a full https:// link.'], [' ', 'Remove spaces before or after the link.'],
  [42, 'Enter a full https:// link.'],
])('capture rejects unsafe/new evidence without rewriting it: %j', (effectivenessEvidenceUrl, reason) => {
  const input = Object.freeze({ ...nc, recordType: 'CAPA', closedDate: '2026-10-01', effectivenessEvidenceUrl });
  expect(validateCapture(input)).toEqual({ effectivenessEvidenceUrl: reason });
  expect(input.effectivenessEvidenceUrl).toBe(effectivenessEvidenceUrl);
});

test('builds the versioned property, preserves original, and clears CAPA-only fields for NC', () => {
  const input = Object.freeze({ ...nc, closedDate: '2026-10-30', effectivenessEvidenceUrl: 'https://example.com' });
  expect(buildCapture(input, '2026-10-31T00:00:00.000Z')).toEqual({
    schemaVersion: 3, recordType: 'NC', partOriginal: nc.partNumber,
    partNorm: 'P-4471-A', partBase: 'P-4471', partRevision: 'A',
    failureMode: 'FM-01', supplier: '', supplierNorm: '', line: '', lineNorm: '', detectedDate: '2026-10-31',
    closedDate: null, effectivenessEvidenceUrl: '', rootCause: '', actionsTaken: '', updatedAt: '2026-10-31T00:00:00.000Z',
  });
});

test('CAPA narrative fields are optional text and saved only for CAPA', () => {
  const input = { ...nc, recordType: 'CAPA', closedDate: '2026-10-30', rootCause: 'Inspection record', actionsTaken: 'Updated fixture' };
  expect(validateCapture(input)).toEqual({});
  expect(buildCapture(input)).toMatchObject({ schemaVersion: 3, rootCause: input.rootCause, actionsTaken: input.actionsTaken });
  expect(buildCapture({ ...input, recordType: 'NC' })).toMatchObject({ rootCause: '', actionsTaken: '' });
  expect(validateCapture({ ...input, rootCause: 1, actionsTaken: 'x'.repeat(2001) })).toMatchObject({ rootCause: expect.any(String), actionsTaken: expect.any(String) });
});
