import { lookbackDays as defaultLookbackDays } from '../config/matching';
import { validDate } from './capture';
import { normalise } from './normalise';

const DAY_MS = 86400000;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = (value) => typeof value === 'string' ? value : '';

export function windowStart(detectedDate, lookbackDays = defaultLookbackDays) {
  if (!validDate(detectedDate) || !Number.isInteger(lookbackDays) || lookbackDays < 0) {
    throw new Error('Invalid matching window.');
  }
  return new Date(Date.parse(`${detectedDate}T00:00:00Z`) - lookbackDays * DAY_MS).toISOString().slice(0, 10);
}

// Captures are flat; candidates add id, key, summary and status. Jira status is
// evidence only: the recorded closedDate defines closure for these rules.
export function matchCaptures(current, candidates, lookbackDays = defaultLookbackDays) {
  const classes = { strong: [], relatedRevision: [], otherRelated: [] };
  if (current?.recordType !== 'NC' || !validDate(current.detectedDate) || !text(current.partOriginal).trim()) return classes;
  const start = windowStart(current.detectedDate, lookbackDays);
  const nc = normalise(current.partOriginal);
  for (const candidate of candidates) {
    if (!candidate || candidate.recordType !== 'CAPA' ||
        (current.id != null && String(candidate.id) === String(current.id)) ||
        (current.key && candidate.key === current.key) ||
        !text(candidate.partOriginal).trim() || !validDate(candidate.closedDate) ||
        candidate.closedDate > current.detectedDate || candidate.closedDate < start) continue;
    const part = normalise(candidate.partOriginal);
    const sameFailureMode = !!text(current.failureMode) && candidate.failureMode === current.failureMode;
    const sameSupplier = !!text(current.supplier).trim() && candidate.supplier === current.supplier;
    const sameLine = !!text(current.line).trim() && candidate.line === current.line;
    let classification;
    if (part.partNorm === nc.partNorm && sameFailureMode) classification = 'strong';
    else if (part.partBase === nc.partBase && part.partRevision !== nc.partRevision && sameFailureMode) classification = 'relatedRevision';
    else if ((part.partNorm === nc.partNorm && !sameFailureMode) ||
             (sameFailureMode && sameSupplier && part.partBase !== nc.partBase)) classification = 'otherRelated';
    if (!classification) continue;
    classes[classification].push({
      id: String(candidate.id ?? ''), key: text(candidate.key), summary: text(candidate.summary),
      status: text(candidate.status), ...part, failureMode: text(candidate.failureMode),
      closedDate: candidate.closedDate,
      rootCause: text(candidate.rootCause), actionsTaken: text(candidate.actionsTaken),
      effectivenessEvidenceUrl: text(candidate.effectivenessEvidenceUrl),
      daysSinceClosure: (Date.parse(`${current.detectedDate}T00:00:00Z`) - Date.parse(`${candidate.closedDate}T00:00:00Z`)) / DAY_MS,
      supportingFacts: [
        ...(sameSupplier ? [`Same supplier: ${current.supplier}`] : []),
        ...(sameLine ? [`Same line: ${current.line}`] : []),
      ],
    });
  }
  for (const matches of Object.values(classes)) {
    matches.sort((a, b) => compare(b.closedDate, a.closedDate) || compare(a.key, b.key));
  }
  return classes;
}
