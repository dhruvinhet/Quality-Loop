// Shared fixtures go through buildMatchJql/normalise, exactly as real captures do.
export const JQL_SECURITY_PARTS = ['SEC"QUOTE', 'SEC\\BACKSLASH', "SEC'APOSTROPHE"];

export function securityCapturePayload(record) {
  return record ? {
    recordType: record.recordType, partNumber: record.partOriginal, failureMode: record.failureMode,
    supplier: record.supplier ?? '', line: record.line ?? '', detectedDate: record.detectedDate ?? '',
    closedDate: record.closedDate ?? '', effectivenessEvidenceUrl: record.effectivenessEvidenceUrl ?? '',
    rootCause: record.rootCause ?? '', actionsTaken: record.actionsTaken ?? '',
  } : { recordType: 'NC', partNumber: 'SECURITY SELF TEST', failureMode: 'FM-01', detectedDate: '2026-10-31' };
}

export function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export function compareSourceIssue(baseline, injected, currentIssueId, otherIssueId) {
  if (!/^\d+$/.test(otherIssueId) || otherIssueId === currentIssueId) return false;
  if (!baseline || !injected || baseline.error || injected.error) return false;
  if (baseline.securityTest?.issueId !== currentIssueId || injected.securityTest?.issueId !== currentIssueId) return false;
  const evidence = ({ elapsedMs, securityTest, ...rest }) => rest;
  return sameJson(evidence(baseline), evidence(injected));
}

export function writePassed(result, expected) {
  const test = result?.securityTest;
  const status = test?.http.find(({ operation }) => operation === 'save PUT')?.status;
  if (expected === 'browse') return status === 403 && test.restored === true && !test.error;
  if (expected === 'edit') return [200, 201].includes(status) && test.restored === true && !test.error;
  return false;
}

export function formatSecurityResults(timestamp, rows, details) {
  return ['QualityLoop Security self-test', `Timestamp: ${timestamp}`, details,
    ...rows.map(({ check, pass, detail }) => `${pass ? 'PASS' : 'FAIL'}\t${check}\t${detail}`)].join('\n');
}
