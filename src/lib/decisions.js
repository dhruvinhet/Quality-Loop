export const DECISION_TYPES = ['CONFIRM', 'NOT_RECURRENCE', 'CONCERN', 'SUPERSEDE'];
export const REASON_CATEGORIES = ['DIFFERENT_MECHANISM', 'DIFFERENT_CAUSE', 'DATA_ERROR', 'OTHER'];
export const STATE_LABELS = {
  NONE: 'Possible recurrence', CONFIRMED: 'Engineer-confirmed recurrence',
  NOT_RECURRENCE: 'Not a recurrence', CONCERN_RAISED: 'Effectiveness concern raised',
};
export const TYPE_LABELS = {
  CONFIRM: 'Confirm recurrence', NOT_RECURRENCE: 'Not a recurrence',
  CONCERN: 'Raise effectiveness concern', SUPERSEDE: 'Correct explanation',
};

export function validIssueId(value) { return typeof value === 'string' && /^\d{1,30}$/.test(value); }
export function pairKey(capaId, issueId) {
  if (!validIssueId(capaId) || !validIssueId(issueId)) throw new Error('Invalid issue identifier.');
  return `${capaId}:${issueId}`;
}
export function decisionKey(capaId, issueId, id) {
  if (!/^\d{13,16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid decision identifier.');
  return `${pairKey(capaId, issueId)}:${id}`;
}
export function validEvidenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || value.trim() !== value ||
      !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export function validateDecision(payload) {
  const errors = {};
  if (!validIssueId(payload.capaId)) errors.capaId = 'Choose a visible CAPA.';
  if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion < 0 || payload.expectedVersion >= 2147483647) {
    errors.expectedVersion = 'Reload the decision before recording it.';
  }
  if (!DECISION_TYPES.includes(payload.type)) errors.type = 'Choose a decision.';
  if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 1000) {
    errors.reason = 'Enter a reason of 1 to 1000 characters.';
  }
  if (payload.type === 'NOT_RECURRENCE') {
    if (!REASON_CATEGORIES.includes(payload.reasonCategory)) errors.reasonCategory = 'Choose a reason category.';
  } else if (payload.reasonCategory != null) errors.reasonCategory = 'A category applies only to Not a recurrence.';
  if (!Array.isArray(payload.evidenceLinks) || payload.evidenceLinks.length > 5 ||
      payload.evidenceLinks.some((url) => !validEvidenceUrl(url))) {
    errors.evidenceLinks = 'Enter at most 5 HTTP or HTTPS URLs without credentials (2000 characters each).';
  }
  return errors;
}
export function concernAllowed(pairState, capa) {
  return pairState?.state === 'CONFIRMED' || !String(capa?.effectivenessEvidenceUrl ?? '').trim();
}
export function nextState(type, previous, capa) {
  if (type === 'CONCERN' && !concernAllowed(previous, capa)) throw new Error('Confirm recurrence first, or review a CAPA with no effectiveness evidence.');
  if (type === 'SUPERSEDE') {
    if (!previous || previous.state === 'NONE') throw new Error('There is no decision to correct.');
    return previous.state;
  }
  const state = { CONFIRM: 'CONFIRMED', NOT_RECURRENCE: 'NOT_RECURRENCE', CONCERN: 'CONCERN_RAISED' }[type];
  if (!state) throw new Error('Invalid decision type.');
  return state;
}
export const emptyPairState = () => ({ version: 0, state: 'NONE' });
export function followupConfirmation(project, capaKey) {
  return `Create task in ${project}: 'Effectiveness re-review: ${capaKey}' and link it to ${capaKey}`;
}
