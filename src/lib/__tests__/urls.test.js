import { evidenceUrlError, validEvidenceUrl } from '../urls';

test.each([
  ['https://user:pass@example.com/x', 'Remove the user name and password from the link.'],
  ['https://user@example.com/x', 'Remove the user name and password from the link.'],
  [' https://example.com/x', 'Remove spaces before or after the link.'],
  ['https://example.com/x ', 'Remove spaces before or after the link.'],
  ['http://example.com/x', 'Use an https:// link.'],
  ['javascript:alert(1)', 'Use an https:// link.'],
  ['ftp://example.com/x', 'Use an https:// link.'],
  ['https://', 'Enter a full https:// link.'],
  ['https:///report.pdf', 'Enter a full https:// link.'],
  ['not a URL', 'Enter a full https:// link.'],
  ['https://example.com/a\nb', 'Enter a full https:// link.'],
])('shared URL reason for %j is actionable: %s', (url, reason) => {
  expect(evidenceUrlError(url)).toBe(reason);
  expect(validEvidenceUrl(url)).toBe(false);
});

test('reason is null for a valid link; legacy HTTP remains display-only', () => {
  expect(evidenceUrlError('https://example.com/x')).toBeNull();
  expect(evidenceUrlError('http://example.com/x', { allowHttp: true })).toBeNull();
});

test.each([
  'https://example.com/evidence', 'HTTPS://example.com/path?x=1#page=2',
  'https://quality.internal:8443/report.pdf', 'https://example.com/a%20b',
])('accepts an unchanged HTTPS evidence URL: %s', (value) => {
  expect(validEvidenceUrl(value)).toBe(true);
});

test.each([
  undefined, null, 42, {}, '', ' ', 'http://example.com/report',
  'javascript:alert(1)', 'file:///report.pdf', '//example.com/report',
  'https:example.com', 'https://', 'https:///report.pdf', 'https://?report=1',
  'https://#report', 'https://user:pass@example.com/x', 'https://user@example.com/x',
  'https://:pass@example.com/x', 'https://@example.com/x',
  ' https://example.com/x', 'https://example.com/x ', '\u00a0https://example.com/x',
  'https://example.com/a b', 'https://example.com/a\nb', 'https://example.com/a\rb',
  'https://example.com/a\tb', 'https://example.com/\u0000x', 'https://example.com/\u007fx',
  'https://example.com/\u0085x', 'https://\\example.com/x',
])('rejects malformed, credentialed or non-HTTPS evidence: %j', (value) => {
  expect(validEvidenceUrl(value)).toBe(false);
});

test('legacy HTTP is recognised only with an explicit display option; unsafe HTTP is never valid', () => {
  const legacy = 'http://example.com/report';
  expect(validEvidenceUrl(legacy)).toBe(false);
  expect(validEvidenceUrl(legacy, { allowHttp: true })).toBe(true);
  for (const value of ['http://user:pass@example.com/x', 'http:///report', 'http://example.com/\nx', ' http://example.com']) {
    expect(validEvidenceUrl(value, { allowHttp: true })).toBe(false);
  }
});

test('preserves the existing 2000-character limit', () => {
  const prefix = 'https://example.com/';
  const longest = prefix + 'x'.repeat(2000 - prefix.length);
  expect(validEvidenceUrl(longest)).toBe(true);
  expect(validEvidenceUrl(longest + 'x')).toBe(false);
});
