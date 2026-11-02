import api, { route } from '@forge/api';
import { validDate } from '../lib/capture';
import { matchCaptures } from '../lib/match';
import { buildMatchJql, buildOtherRelatedJql } from '../lib/matchJql';
import { BudgetExceeded, checkJira, loadBudget } from './loadBudget';

export const MATCH_CANDIDATE_LIMIT = 200;
export const OTHER_RELATED_LIMIT = 20;
const classes = ['strong', 'relatedRevision', 'otherRelated'];
const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
export function issueCapture(issue) {
  const capture = issue?.properties?.qualityloop;
  if (!capture || ![1, 2].includes(capture.schemaVersion)) return null;
  return { ...capture, id: String(issue.id), key: issue.key, summary: issue.fields?.summary, status: issue.fields?.status?.name };
}

export async function findMatches(issueId, budget = loadBudget(), authorised = new Map()) {
  const started = Date.now();
  const result = { applicable: true, strong: [], relatedRevision: [], otherRelated: [],
    matchesIncomplete: false, otherRelatedIncomplete: false, incomplete: false };
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
          for (const kind of allowed) if (classified[kind].length) selected.push({ id, kind });
        }
        const more = data.isLast !== true && (!!data.nextPageToken || data.isLast === false);
        token = more ? data.nextPageToken : undefined;
        pages += 1;
        if ((more && (fetched >= limit || !token || pages >= limit)) || (data.issues?.length > rows.length)) result[flag] = true;
        // Related queries deliberately disclose reaching their cap conservatively.
        if (flag === 'otherRelatedIncomplete' && fetched >= limit) result[flag] = true;
        if (fetched >= limit || pages >= limit) break;
      } while (token);
      // Only selected cards get direct reads, in batches of at most five.
      for (let offset = 0; offset < selected.length; offset += 5) {
        const batch = await Promise.all(selected.slice(offset, offset + 5).map(async ({ id, kind }) => {
          const fresh = await budget.run(() => api.asUser().requestJira(
            route`/rest/api/3/issue/${id}?fields=summary,status&properties=qualityloop`, { headers }));
          if ([403, 404].includes(fresh.status)) return null;
          checkJira(fresh);
          const issue = await budget.run(() => fresh.json());
          if (String(issue.id) !== id) return null;
          const match = matchCaptures(nc, [issueCapture(issue)])[kind][0];
          return match ? { issue, kind, match } : null;
        }));
        for (const item of batch.filter(Boolean)) {
          authorised.set(item.match.id, item.issue);
          result[item.kind].push(item.match);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    result.incomplete = true;
  }
  for (const kind of classes) result[kind].sort((a, b) => b.closedDate.localeCompare(a.closedDate) || a.key.localeCompare(b.key));
  return { ...result, elapsedMs: Date.now() - started };
}
