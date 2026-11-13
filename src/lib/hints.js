import { validDate } from './capture';
import { matchCaptures, windowStart } from './match';
import { normalise, normaliseText } from './normalise';

export const HINT_LIMIT = 3;
export const HINT_CANDIDATE_LIMIT = 50;
const text = (value) => typeof value === 'string' ? value : '';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Compaction is for explicitly labelled hints only, never for matching.
export const compactPart = (value) => text(value).toUpperCase().replace(/[\s-]/g, '');

// Damerau-Levenshtein <= 1: equality, one insertion/deletion/substitution,
// or one adjacent transposition. A threshold check needs only linear work.
export function differsByAtMostOneEdit(left, right) {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < Math.min(left.length, right.length) && left[index] === right[index]) index++;
  if (left.length < right.length) return left.slice(index) === right.slice(index + 1);
  if (left.length > right.length) return left.slice(index + 1) === right.slice(index);
  if (left.slice(index + 1) === right.slice(index + 1)) return true;
  return index + 1 < left.length && left[index] === right[index + 1] &&
    left[index + 1] === right[index] && left.slice(index + 2) === right.slice(index + 2);
}

export function excludeMatchedHints(hints, matches) {
  const excluded = [...(matches?.strong ?? []), ...(matches?.relatedRevision ?? [])];
  return hints.filter(({ id, key }) => !excluded.some((match) =>
    (id && String(match.id) === String(id)) || (key && match.key === key)));
}

export function selectHints(current, candidates) {
  if (current?.recordType !== 'NC' || !validDate(current.detectedDate) ||
      !text(current.partOriginal).trim() || !text(current.failureMode).trim()) return [];
  const start = windowStart(current.detectedDate);
  const nc = normalise(current.partOriginal);
  const mode = normaliseText(current.failureMode);
  const compact = compactPart(current.partOriginal);
  const matches = matchCaptures(current, candidates);
  const hints = [];
  for (const candidate of excludeMatchedHints(candidates.filter(Boolean), matches)) {
    if (!candidate || candidate.recordType !== 'CAPA' || !text(candidate.partOriginal).trim() ||
        (current.id != null && String(candidate.id) === String(current.id)) ||
        (current.key && current.key === candidate.key) ||
        normaliseText(text(candidate.failureMode)) !== mode) continue;
    const part = normalise(candidate.partOriginal);
    const closed = candidate.closedDate;
    let reason;
    let priority;
    if (validDate(closed) && closed >= start && closed < current.detectedDate &&
        part.partBase !== nc.partBase && differsByAtMostOneEdit(compact, compactPart(candidate.partOriginal))) {
      reason = `Part number differs slightly: stored "${candidate.partOriginal}", this NC "${current.partOriginal}"`; priority = 0;
    } else if (part.partNorm === nc.partNorm && (closed == null || closed === '')) {
      reason = 'No closed date recorded'; priority = 1;
    } else if (part.partNorm === nc.partNorm && validDate(closed) && closed < start) {
      const days = (Date.parse(`${current.detectedDate}T00:00:00Z`) - Date.parse(`${closed}T00:00:00Z`)) / 86400000;
      reason = `Older precedent: closed ${days} days before detection (outside the 365-day window)`; priority = 2;
    } else continue;
    hints.push({ id: String(candidate.id ?? ''), key: text(candidate.key), summary: text(candidate.summary),
      partOriginal: candidate.partOriginal, failureMode: candidate.failureMode,
      closedDate: closed ?? null, reason, priority });
  }
  hints.sort((a, b) => a.priority - b.priority || compare(b.closedDate ?? '', a.closedDate ?? '') ||
    compare(a.key, b.key) || compare(a.id, b.id));
  const ids = new Set();
  const keys = new Set();
  return hints.filter(({ id, key }) => {
    if ((id && ids.has(id)) || (key && keys.has(key))) return false;
    if (id) ids.add(id);
    if (key) keys.add(key);
    return true;
  }).slice(0, HINT_LIMIT).map((rankedHint) => {
    const hint = { ...rankedHint };
    delete hint.priority;
    return hint;
  });
}
