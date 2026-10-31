import { concernAllowed, decisionKey, emptyPairState, followupConfirmation, nextState, pairKey, validateDecision } from '../decisions';

const payload = { capaId: '20002', expectedVersion: 0, type: 'CONFIRM', reason: 'Observed signature reviewed', evidenceLinks: [] };
test('validates reason boundaries and requires a reason for every action', () => {
  expect(validateDecision(payload)).toEqual({});
  for (const reason of ['', '   ', null, 25, 'x'.repeat(1001)]) expect(validateDecision({ ...payload, reason })).toHaveProperty('reason');
  expect(validateDecision({ ...payload, reason: 'x'.repeat(1000) })).toEqual({});
});
test('requires a known category only for NOT_RECURRENCE', () => {
  expect(validateDecision({ ...payload, type: 'NOT_RECURRENCE' })).toHaveProperty('reasonCategory');
  for (const reasonCategory of ['DIFFERENT_MECHANISM', 'DIFFERENT_CAUSE', 'DATA_ERROR', 'OTHER']) {
    expect(validateDecision({ ...payload, type: 'NOT_RECURRENCE', reasonCategory })).toEqual({});
  }
  expect(validateDecision({ ...payload, reasonCategory: 'OTHER' })).toHaveProperty('reasonCategory');
  expect(validateDecision({ ...payload, type: 'NOT_RECURRENCE', reasonCategory: 'something' })).toHaveProperty('reasonCategory');
});
test('permits up to five HTTP(S) evidence URLs and rejects malformed or credential URLs', () => {
  expect(validateDecision({ ...payload, evidenceLinks: Array(5).fill('https://example.com/evidence') })).toEqual({});
  for (const evidenceLinks of [null, 'https://example.com', Array(6).fill('https://example.com'),
    ['javascript:alert(1)'], ['file:///test'], ['not a URL'], ['https:example.com'], ['https://example.com/a\nb'],
    ['https://user:pass@example.com'], [' https://example.com'], ['https://example.com/' + 'x'.repeat(2000)]]) {
    expect(validateDecision({ ...payload, evidenceLinks })).toHaveProperty('evidenceLinks');
  }
});
test('validates IDs, expected versions and action type', () => {
  for (const capaId of ['x:2', '../123', 123, '']) expect(validateDecision({ ...payload, capaId })).toHaveProperty('capaId');
  for (const expectedVersion of [-1, 0.2, '0', null, 2147483647]) expect(validateDecision({ ...payload, expectedVersion })).toHaveProperty('expectedVersion');
  expect(validateDecision({ ...payload, type: 'DELETE' })).toHaveProperty('type');
});
test('uses unambiguous pair and timestamp-prefixed unique decision keys', () => {
  expect(pairKey('20002', '10001')).toBe('20002:10001');
  expect(decisionKey('20002', '10001', '1793400000000-12345678-1234-1234-1234-123456789abc'))
    .toBe('20002:10001:1793400000000-12345678-1234-1234-1234-123456789abc');
  expect(() => pairKey('20002:100', '1')).toThrow();
  expect(() => decisionKey('20002', '10001', 'client-id')).toThrow();
});
test.each(['NONE', 'CONFIRMED', 'NOT_RECURRENCE', 'CONCERN_RAISED'])('latest explicit action wins from %s', (state) => {
  expect(nextState('CONFIRM', { state }, {})).toBe('CONFIRMED');
  expect(nextState('NOT_RECURRENCE', { state }, {})).toBe('NOT_RECURRENCE');
});
test('concern needs a confirmed pair or absent evidence, independently of match strength', () => {
  const evidence = { effectivenessEvidenceUrl: 'https://example.com' };
  expect(concernAllowed(emptyPairState(), evidence)).toBe(false);
  expect(concernAllowed({ state: 'CONFIRMED' }, evidence)).toBe(true);
  expect(concernAllowed({ state: 'NOT_RECURRENCE' }, {})).toBe(true);
  expect(nextState('CONCERN', null, {})).toBe('CONCERN_RAISED');
  expect(() => nextState('CONCERN', { state: 'CONCERN_RAISED' }, evidence)).toThrow();
});
test('SUPERSEDE corrects the explanation while preserving an established state', () => {
  expect(() => nextState('SUPERSEDE', null, {})).toThrow();
  expect(() => nextState('SUPERSEDE', emptyPairState(), {})).toThrow();
  for (const state of ['CONFIRMED', 'NOT_RECURRENCE', 'CONCERN_RAISED']) expect(nextState('SUPERSEDE', { state }, {})).toBe(state);
});
test('confirmation names the exact task and CAPA link', () => {
  expect(followupConfirmation('QL', 'QL-42')).toBe("Create task in QL: 'Effectiveness re-review: QL-42' and link it to QL-42");
});
