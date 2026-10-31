import { compareSourceIssue, formatSecurityResults, JQL_SECURITY_PARTS, sameJson, securityCapturePayload, writePassed } from '../securitySelfTest';
import { buildMatchJql } from '../matchJql';
import { normalise } from '../normalise';
import { validateCapture } from '../capture';

test('fixture parts retain quote, backslash and apostrophe through the real normaliser and builder', () => {
  expect(JQL_SECURITY_PARTS.map((part) => normalise(part).partBase)).toEqual(JQL_SECURITY_PARTS);
  for (const partOriginal of JQL_SECURITY_PARTS) {
    const jql = buildMatchJql({ partOriginal, failureMode: 'FM-01', detectedDate: '2026-10-31' });
    expect(jql).toContain('qlPartBase = ');
    expect(jql).toContain('qlClosed >= "2025-10-31"');
  }
});

test('structural equality ignores object key order but keeps values, keys and array order', () => {
  expect(sameJson({ b: [1, null], a: { x: true } }, { a: { x: true }, b: [1, null] })).toBe(true);
  for (const [left, right] of [[{ x: null }, {}], [[1, 2], [2, 1]], [null, {}], [[], {}], [{ a: 1 }, { a: '1' }]]) {
    expect(sameJson(left, right)).toBe(false);
  }
});

const source = (issueId, record = { partOriginal: 'P-1' }) => ({ record, securityTest: { issueId }, elapsedMs: 10 });
test('injection requires the current source ID AND identical evidence, allowing elapsed time differences', () => {
  expect(compareSourceIssue(source('1'), { ...source('1'), elapsedMs: 999 }, '1', '2')).toBe(true);
  expect(compareSourceIssue(source('1'), source('2'), '1', '2')).toBe(false);
  expect(compareSourceIssue(source('1'), source('1', { partOriginal: 'OTHER' }), '1', '2')).toBe(false);
  expect(compareSourceIssue(source('1'), source('1'), '1', '1')).toBe(false);
  expect(compareSourceIssue(source('1'), source('1'), '1', 'QL-2')).toBe(false);
  expect(compareSourceIssue(null, null, '1', '2')).toBe(false);
  expect(compareSourceIssue({ error: 'denied' }, { error: 'denied' }, '1', '2')).toBe(false);
});

const write = (status, restored = true, error) => ({ securityTest: { http: [{ operation: 'save PUT', status }], restored, error } });
test('write verdicts cannot treat success for a browse-only user or failed restoration as PASS', () => {
  expect(writePassed(write(403), 'browse')).toBe(true);
  for (const status of [200, 201, 404, 401, 500]) expect(writePassed(write(status), 'browse')).toBe(false);
  for (const status of [200, 201]) expect(writePassed(write(status), 'edit')).toBe(true);
  expect(writePassed(write(200, false), 'edit')).toBe(false);
  expect(writePassed(write(200, true, 'restore failed'), 'edit')).toBe(false);
  expect(writePassed(null, 'edit')).toBe(false);
});

test('harmless payload preserves input fields and yields a valid fixture for absent captures', () => {
  expect(validateCapture(securityCapturePayload(null))).toEqual({});
  const record = { recordType: 'CAPA', partOriginal: ' p-1-a ', failureMode: 'FM-01', rootCause: 'why', actionsTaken: 'what', updatedAt: 'old', extra: 'keep on restore' };
  const payload = securityCapturePayload(record);
  expect(payload).toMatchObject({ recordType: 'CAPA', partNumber: ' p-1-a ', rootCause: 'why', actionsTaken: 'what' });
  expect(payload).not.toHaveProperty('updatedAt');
  expect(payload).not.toHaveProperty('extra');
  expect(record.extra).toBe('keep on restore');
});

test('copy text includes timestamp, expectations, PASS/FAIL and raw statuses/errors', () => {
  expect(formatSecurityResults('2026-10-31T00:00:00Z', [
    { check: 'write', pass: true, detail: 'HTTP 403' }, { check: 'JQL', pass: false, detail: 'HTTP 400' },
  ], 'expected browse')).toBe('QualityLoop Security self-test\nTimestamp: 2026-10-31T00:00:00Z\nexpected browse\nPASS\twrite\tHTTP 403\nFAIL\tJQL\tHTTP 400');
});
