import { evidenceUrlError } from './urls';

export const DECISION_TYPES = ['CONFIRM', 'NOT_RECURRENCE', 'CONCERN', 'SUPERSEDE'];
export const REASON_CATEGORIES = ['DIFFERENT_MECHANISM', 'DIFFERENT_CAUSE', 'DATA_ERROR', 'OTHER'];
export const STATE_LABELS = {
  NONE: 'Possible recurrence', CONFIRMED: 'Engineer-confirmed recurrence',
  NOT_RECURRENCE: 'Not a recurrence', CONCERN_RAISED: 'Effectiveness concern',
};
export const TYPE_LABELS = {
  CONFIRM: 'Engineer-confirmed recurrence', NOT_RECURRENCE: 'Not a recurrence',
  CONCERN: 'Effectiveness concern', SUPERSEDE: 'Correct explanation',
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
  if (!Array.isArray(payload.evidenceLinks) || payload.evidenceLinks.length > 5) {
    errors.evidenceLinks = 'Enter at most 5 HTTPS URLs (2000 characters each).';
  } else {
    const reason = payload.evidenceLinks.map((url) => evidenceUrlError(url)).find(Boolean);
    if (reason) errors.evidenceLinks = reason;
  }
  return errors;
}
export function concernAllowed(pairState, capa) {
  return pairState?.state === 'CONFIRMED' || !String(capa?.effectivenessEvidenceUrl ?? '').trim();
}
export function nextState(type, previous, capa) {
  if (type === 'CONCERN' && !concernAllowed(previous, capa)) throw new Error('Record an Engineer-confirmed recurrence first, or review a CAPA with no effectiveness evidence.');
  if (type === 'SUPERSEDE') {
    if (!previous || previous.state === 'NONE') throw new Error('There is no decision to correct.');
    return previous.state;
  }
  const state = { CONFIRM: 'CONFIRMED', NOT_RECURRENCE: 'NOT_RECURRENCE', CONCERN: 'CONCERN_RAISED' }[type];
  if (!state) throw new Error('Invalid decision type.');
  return state;
}
export const emptyPairState = () => ({ version: 0, state: 'NONE' });
export function confirmedAfter(type, previous = false) {
  if (type === 'CONFIRM') return true;
  if (type === 'NOT_RECURRENCE') return false;
  return previous;
}

// Newest decisive event wins; concerns and explanation corrections do not reset it.
export function confirmedFromHistory(history) {
  const decisive = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .find(({ type }) => ['CONFIRM', 'NOT_RECURRENCE'].includes(type));
  return decisive ? decisive.type === 'CONFIRM' : false;
}
export function followupConfirmation(project, capaKey, assignee) {
  const ownership = assignee?.accountId
    ? `Intended assignee: ${assignee.displayName?.trim() || "the CAPA's current assignee"}. If Jira rejects this assignee, the task is created unassigned.`
    : 'Assignee: none (the CAPA has no assignee).';
  return `Create task in ${project}: 'Effectiveness re-review: ${capaKey}' and link it to ${capaKey}. Add a hidden QualityLoop marker to the new task so it can be identified later. ${ownership}`;
}
