import { escapeJqlValue } from './matchJql';

export const followupSummary = (capaKey) => `Effectiveness re-review: ${capaKey}`;
export const FOLLOWUP_PROPERTY = 'qualityloop-followup';
export const legacyMarkerWarning = 'This task has no QualityLoop marker; confirm only if you know it is the follow-up task.';
export const followupMarker = (decisionId, decision) => ({ schemaVersion: 1, decisionId,
  capaId: decision.capaId, ncId: decision.issueId, claimedAt: decision.taskClaimedAt });

// Only pre-marker claims can recover unmarked legacy tasks. A present but
// conflicting/malformed marker must never fall back to summary-based recovery.
export function recoveryMarkerKind(task, decisionId, decision) {
  if (!Object.hasOwn(task?.properties ?? {}, FOLLOWUP_PROPERTY)) return decision.taskMarkerVersion == null ? 'legacy' : null;
  const actual = task.properties[FOLLOWUP_PROPERTY];
  const expected = followupMarker(decisionId, decision);
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value) ? 'marked' : null;
}

export function hasCapaLink(task, capa) {
  return task?.fields?.issuelinks?.some((link) => link.type?.name?.toLowerCase() === 'relates'
    && [link.inwardIssue, link.outwardIssue].some((issue) => issue &&
      (String(issue.id) === String(capa.id) || issue.key === capa.key))) === true;
}

export function repairLinkConfirmation(taskKey, capaKey, { writeMarker = false, legacy = false } = {}) {
  return `Create a Relates link from ${taskKey} to ${capaKey} only if absent, then record link completion.`
    + (writeMarker ? ` Set the ${FOLLOWUP_PROPERTY} marker property on ${taskKey} for this decision.` : '')
    + (legacy ? ` ${legacyMarkerWarning}` : '');
}

export function recoveryJql(projectId, capaKey, claimedAt) {
  const claim = Date.parse(claimedAt);
  if (!Number.isFinite(claim) || !/^\d+$/.test(projectId) || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(capaKey)) {
    throw new Error('Follow-up search context is unavailable.');
  }
  // Jira date literals use the viewer's timezone and minute precision. Search
  // from the previous UTC day, then enforce the exact timestamp on direct reads.
  const start = new Date(claim - 86400000).toISOString().slice(0, 10);
  return `project = ${escapeJqlValue(projectId)} AND summary ~ ${escapeJqlValue(`"${followupSummary(capaKey)}"`)} AND created >= ${escapeJqlValue(start)} ORDER BY created DESC, key ASC`;
}

export function isRecoveryTask(issue, projectId, capaKey, claimedAt) {
  return issue?.fields?.project?.id === projectId && issue.fields.summary === followupSummary(capaKey)
    && Date.parse(issue.fields.created) > Date.parse(claimedAt);
}

export const recoveryConfirmation = (taskKey, capaKey, legacy = false) =>
  `Record ${taskKey} as the follow-up task for the recorded effectiveness concern on ${capaKey}.${legacy ? ` ${legacyMarkerWarning}` : ''}`;
