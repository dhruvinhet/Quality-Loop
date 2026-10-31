import { validIssueId } from './decisions';

export const RECORD_ENTITIES = ['decision', 'pair-state'];

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

// Only an explicit 404 is an orphan. A 403, 429, network error or 5xx is unknown.
export async function detectOrphans(records, getIssue) {
  const ids = [...new Set(records.flatMap(({ entity, key, value }) => recordReferences(entity, key, value)))];
  const missing = new Set();
  const unknown = new Set();
  for (let offset = 0; offset < ids.length; offset += 5) {
    await Promise.all(ids.slice(offset, offset + 5).map(async (id) => {
      try {
        const response = await getIssue(id);
        if (response.status === 404) missing.add(id);
        else if (!response.ok) unknown.add(id);
      } catch { unknown.add(id); }
    }));
  }
  return { records: recordsForIssues(records, [...missing]), missingIds: [...missing].sort(), unknownIds: [...unknown].sort() };
}
