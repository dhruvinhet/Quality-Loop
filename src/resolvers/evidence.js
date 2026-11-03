import api, { route } from '@forge/api';
import { validDate } from '../lib/capture';
import { matchCaptures } from '../lib/match';
import { buildMatchJql, buildOtherRelatedJql } from '../lib/matchJql';
import { BudgetExceeded, checkJira, loadBudget } from './loadBudget';

export const MATCH_CANDIDATE_LIMIT = 200;
export const MATCH_DISPLAY_LIMIT = 25;
export const OTHER_RELATED_LIMIT = 20;
const classes = ['strong', 'relatedRevision', 'otherRelated'];
const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
export function issueCapture(issue) {
  const capture = issue?.properties?.qualityloop;
  if (!capture || ![1, 2].includes(capture.schemaVersion)) return null;
  return { ...capture, id: String(issue.id), key: issue.key, summary: issue.fields?.summary,
    status: issue.fields?.status?.name, statusCategory: issue.fields?.status?.statusCategory?.key };
}

export async function findMatches(issueId, budget = loadBudget(), authorised = new Map(), undisplayed = new Set()) {
  const started = Date.now();
  const result = { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    matchesIncomplete: false, otherRelatedIncomplete: false, incomplete: false, uncheckedCandidates: false,
    notShown: { strong: 0, relatedRevision: 0 } };
  const unchecked = new Map();
  try {
    const response = await budget.run(() => api.asUser().requestJira(
      route`/rest/api/3/issue/${issueId}/properties/qualityloop`, { headers }));
    if ([403, 404].includes(response.status)) return null;
    checkJira(response);
    const current = (await budget.run(() => response.json())).value;
    if (current == null) return null;
    if (![1, 2].includes(current.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
    if (current.recordType !== 'NC' || !validDate(current.detectedDate)) return { applicable: false };
    const nc = { ...current, id: issueId };
    const seen = new Set([issueId]);
    const queries = [[buildMatchJql(current), MATCH_CANDIDATE_LIMIT, 'matchesIncomplete', ['strong', 'relatedRevision']],
      ...buildOtherRelatedJql(current).map((jql) => [jql, OTHER_RELATED_LIMIT, 'otherRelatedIncomplete', ['otherRelated']])];
    for (const [jql, limit, flag, allowed] of queries) {
      let token;
      let fetched = 0;
      let pages = 0;
      const selected = [];
      do {
        const search = await budget.run(() => api.asUser().requestJira(route`/rest/api/3/search/jql`, {
          method: 'POST', headers, body: JSON.stringify({ jql, maxResults: Math.min(50, limit - fetched),
            fields: ['summary', 'status'], properties: ['qualityloop'], ...(token ? { nextPageToken: token } : {}) }),
        }));
        if ([403, 404].includes(search.status)) return null;
        checkJira(search);
        const data = await budget.run(() => search.json());
        const rows = (data.issues ?? []).slice(0, limit - fetched);
        fetched += rows.length;
        for (const issue of rows) {
          const id = String(issue.id);
          if (!/^\d+$/.test(id) || seen.has(id)) continue;
          seen.add(id);
          const classified = matchCaptures(nc, [issueCapture(issue)]);
          for (const kind of allowed) if (classified[kind].length) {
            selected.push({ id, kind, match: classified[kind][0] });
            if (kind !== 'otherRelated') unchecked.set(id, kind);
          }
        }
        const more = data.isLast !== true && (!!data.nextPageToken || data.isLast === false);
        token = more ? data.nextPageToken : undefined;
        pages += 1;
        if ((more && (fetched >= limit || !token || pages >= limit)) || (data.issues?.length > rows.length)) result[flag] = true;
        // Related queries deliberately disclose reaching their cap conservatively.
        if (flag === 'otherRelatedIncomplete' && fetched >= limit) result[flag] = true;
        if (fetched >= limit || pages >= limit) break;
      } while (token);
      // Track candidates from this asUser snapshot only, never a Jira total.
      // A candidate is not a verified match until its direct read completes.
      const sortedClasses = allowed.map((kind) => [kind, selected.filter((item) => item.kind === kind)
        .sort((a, b) => b.match.closedDate.localeCompare(a.match.closedDate) || a.match.key.localeCompare(b.match.key))]);
      for (const [kind, sorted] of sortedClasses) {
        const limit = kind === 'otherRelated' ? result[kind].length + sorted.length : MATCH_DISPLAY_LIMIT;
        // Refill after denied or changed records, without reading beyond the
        // remaining display slots. All work shares the original time budget.
        for (let offset = 0; offset < sorted.length && result[kind].length < limit;) {
          const candidates = sorted.slice(offset, offset + Math.min(5, limit - result[kind].length));
          offset += candidates.length;
          const batch = await Promise.allSettled(candidates.map(async ({ id }) => {
            const fresh = await budget.run(() => api.asUser().requestJira(
              route`/rest/api/3/issue/${id}?fields=summary,status&properties=qualityloop`, { headers }));
            if ([403, 404].includes(fresh.status)) { unchecked.delete(id); return null; }
            checkJira(fresh);
            const issue = await budget.run(() => fresh.json());
            unchecked.delete(id);
            if (String(issue.id) !== id) return null;
            const classified = matchCaptures(nc, [issueCapture(issue)]);
            const freshKind = allowed.find((name) => classified[name].length);
            return freshKind ? { issue, kind: freshKind, match: classified[freshKind][0] } : null;
          }));
          for (const settled of batch) {
            if (settled.status !== 'fulfilled' || !settled.value) continue;
            const item = settled.value;
            authorised.set(item.match.id, item.issue);
            result[item.kind].push(item.match);
            if (item.kind !== 'otherRelated') {
              // A re-read may move into a full signature class. Retain its
              // newest verified matches without exceeding the per-class cap.
              result[item.kind].sort((a, b) => b.closedDate.localeCompare(a.closedDate) || a.key.localeCompare(b.key));
              for (const omitted of result[item.kind].splice(MATCH_DISPLAY_LIMIT)) {
                authorised.delete(omitted.id);
                undisplayed.add(omitted.id);
              }
            }
          }
          const failure = batch.find((item) => item.status === 'rejected');
          if (failure) throw failure.reason;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    result.incomplete = true;
  }
  for (const [id, kind] of unchecked) {
    result.notShown[kind] += 1;
    undisplayed.add(id);
  }
  result.uncheckedCandidates = unchecked.size > 0;
  for (const kind of classes) result[kind].sort((a, b) => b.closedDate.localeCompare(a.closedDate) || a.key.localeCompare(b.key));
  return { ...result, elapsedMs: Date.now() - started };
}
