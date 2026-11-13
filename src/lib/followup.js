import { escapeJqlValue } from './matchJql';
import { TYPE_LABELS } from './decisions';
import { validEvidenceUrl } from './urls';

export const followupSummary = (capaKey) => `Effectiveness re-review: ${capaKey}`;
export const FOLLOWUP_PROPERTY = 'qualityloop-followup';
export function followupDescription(decision, nc, capa) {
  const text = (value, href) => ({ type: 'text', text: String(value),
    ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) });
  const paragraph = (...content) => ({ type: 'paragraph', content });
  const ncUrl = new URL(`/browse/${encodeURIComponent(nc.key)}`, nc.self).href;
  if (!validEvidenceUrl(ncUrl)) throw new Error('NC URL is unavailable.');
  return { type: 'doc', version: 1, content: [
    paragraph(text(`Decision: ${TYPE_LABELS[decision.type] ?? decision.type}`)),
    paragraph(text('NC: '), text(`${nc.key}: ${nc.fields?.summary ?? ''}`, ncUrl)),
    paragraph(text(`CAPA: ${capa.key}`)),
    paragraph(text(`Engineer reason: ${decision.reason}`)),
    ...(decision.reasonCategory ? [paragraph(text(`Reason category: ${decision.reasonCategory}`))] : []),
    ...(decision.evidenceLinks ?? []).filter((url) => validEvidenceUrl(url)).map((url) => paragraph(text(url, url))),
    paragraph(text(`Open the QualityLoop panel on ${nc.key} to see the full history.`)),
  ] };
}
export const descriptionPreview = (description) => description.content.map((p) => p.content.map((node) => node.text).join('')).join('\n');
export function hasDescription(task) {
  const value = task?.fields?.description;
  if (value == null) return false;
  if (typeof value === 'string') return !!value.trim();
  if (value.type !== 'doc') return true; // Unknown content is never overwritten as "empty".
  return value.content?.some((p) => p.type !== 'paragraph' || p.content?.some((node) => node.type !== 'text' || node.text?.trim())) === true;
}
export const legacyMarkerWarning = 'This task has no QualityLoop marker; confirm only if you know it is the follow-up task.';
const legacyMarker = (decisionId, decision) => ({ schemaVersion: 1, decisionId,
  capaId: decision.capaId, ncId: decision.issueId, claimedAt: decision.taskClaimedAt });
const validToken = (token) => typeof token === 'string' && /^[a-f0-9]{32}$/.test(token);
export function followupMarker(decisionId, decision) {
  if (decision.taskMarkerVersion === 2 || decision.taskMarkerToken != null) {
    if (!validToken(decision.taskMarkerToken)) throw new Error('Follow-up marker token is unavailable.');
    return { schemaVersion: 2, token: decision.taskMarkerToken };
  }
  return legacyMarker(decisionId, decision);
}

// Only pre-marker claims can recover unmarked legacy tasks. A present but
// conflicting/malformed marker must never fall back to summary-based recovery.
export function recoveryMarkerKind(task, decisionId, decision) {
  if (!Object.hasOwn(task?.properties ?? {}, FOLLOWUP_PROPERTY)) {
    return decision.taskMarkerVersion == null && decision.taskMarkerToken == null ? 'legacy' : null;
  }
  const actual = task.properties[FOLLOWUP_PROPERTY];
  if (decision.taskMarkerVersion === 2 || decision.taskMarkerToken != null) {
    return actual?.schemaVersion === 2 && validToken(decision.taskMarkerToken)
      && actual.token === decision.taskMarkerToken ? 'marked' : null;
  }
  const expected = legacyMarker(decisionId, decision);
  return actual && Object.entries(expected).every(([key, value]) => actual[key] === value) ? 'marked' : null;
}

export function hasCapaLink(task, capa) {
  return task?.fields?.issuelinks?.some((link) => link.type?.name?.toLowerCase() === 'relates'
    && [link.inwardIssue, link.outwardIssue].some((issue) => issue &&
      (String(issue.id) === String(capa.id) || issue.key === capa.key))) === true;
}

export function repairLinkConfirmation(taskKey, capaKey, { ncKey, description, linkAvailable = true, writeMarker = false, legacy = false } = {}) {
  return `Verify ${taskKey}. Set its ADF description only if empty: ${description}. Check Relates links to CAPA ${capaKey} and NC ${ncKey}; add each link only if missing. Record description and both link completions.`
    + (!linkAvailable ? ' Enable the Relates link type; missing links cannot be repaired until it is available.' : '')
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
