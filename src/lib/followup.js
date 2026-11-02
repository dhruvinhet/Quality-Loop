import { escapeJqlValue } from './matchJql';

export const followupSummary = (capaKey) => `Effectiveness re-review: ${capaKey}`;

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

export const recoveryConfirmation = (taskKey, capaKey) => `Record ${taskKey} as the follow-up task for the recorded effectiveness concern on ${capaKey}.`;
