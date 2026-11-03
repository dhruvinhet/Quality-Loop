import { validIssueId } from './decisions';

export const RECORD_ENTITIES = ['decision', 'pair-state'];

// A 404 cannot distinguish a deleted issue from one in a restorable project.
// Callers must explicitly establish trash safety before it permits removal.
export function orphanClassification(references, statuses, trashExcluded = false) {
  if (references.length !== 2) return 'unknown';
  if (statuses.includes(404)) return trashExcluded === true ? 'orphan' : 'unknown';
  return statuses.length === 2 && statuses.every((status) => status === 200) ? 'live' : 'unknown';
}

export function recordReferences(entity, key, value) {
  // Legacy pair-state records have no ID attributes. Their validated key is authoritative.
  const match = entity === 'pair-state' && /^(\d{1,30}):(\d{1,30})$/.exec(key);
  const capaId = match ? match[1] : value?.capaId;
  const issueId = match ? match[2] : value?.issueId;
  return [issueId, capaId].filter(validIssueId);
}

export function recordsForIssues(records, issueIds) {
  const ids = new Set(issueIds);
  return records.filter(({ entity, key, value }) => recordReferences(entity, key, value).some((id) => ids.has(id)));
}

// Authorise both references before exposing counts or changing a stored record.
// A user-context 404 cannot distinguish a deletion from an issue security denial.
export async function visibleRecords(records, getIssue) {
  const ids = [...new Set(records.flatMap(({ entity, key, value }) => recordReferences(entity, key, value)))];
  const visible = new Set();
  for (let offset = 0; offset < ids.length; offset += 5) {
    await Promise.all(ids.slice(offset, offset + 5).map(async (id) => {
      const response = await getIssue(id);
      if ([403, 404].includes(response.status)) return;
      if (!response.ok) throw new Error('Issue access could not be checked.');
      visible.add(id);
    }));
  }
  return records.filter(({ entity, key, value }) => {
    const refs = recordReferences(entity, key, value);
    return refs.length === 2 && refs.every((id) => visible.has(id));
  });
}
