import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { buildCapture, CAPTURE_FIELDS, validateCapture, validDate } from '../lib/capture';
import { findMatches } from './evidence';
import { BudgetExceeded, JIRA_BUSY, checkJira, loadBudget } from './loadBudget';
import { buildHintJql } from '../lib/hintJql';
import { HINT_CANDIDATE_LIMIT, selectHints } from '../lib/hints';
import { registerDecisionResolvers } from './decisions';
import { readFailureModes } from './failureModes';

const resolver = new Resolver();

const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

function issueFromContext(req) {
  const issueId = String(req.context?.extension?.issue?.id ?? '');
  if (!/^\d+$/.test(issueId)) throw new Error('Issue context is unavailable. Reopen the issue panel.');
  return issueId;
}

function allowFields(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !fields.includes(key))) {
    throw new Error('Invalid request fields.');
  }
}

// Reject unexpected payload identifiers before any API or storage operation.
function define(name, fields, fn) {
  resolver.define(name, async (req) => {
    try {
      const payload = req.payload ?? {};
      allowFields(payload, fields);
      return await fn(issueFromContext(req), payload, req.context);
    } catch (error) {
      if (error.message === JIRA_BUSY) return { error: JIRA_BUSY };
      console.error(`QualityLoop ${name} failed.`);
      return { error: 'QualityLoop could not complete the request. Reopen the panel and try again.' };
    }
  });
}

async function readProperty(issueId, propertyKey) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`,
    { headers: { Accept: 'application/json' } },
  );
  if (response.status === 403 || response.status === 404) return null;
  checkJira(response);
  return (await response.json()).value;
}

async function writeProperty(issueId, propertyKey, value) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`,
    { method: 'PUT', headers, body: JSON.stringify(value) },
  );
  if (response.status === 403 || response.status === 404) return null;
  checkJira(response);
  return true;
}

define('loadCapture', [], async (issueId) => {
  const record = await readProperty(issueId, 'qualityloop');
  if (record == null) return null;
  if (![1, 2, 3].includes(record.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
  return { record };
});

define('getFailureModes', [], async (issueId) => {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}?fields=id`, { headers });
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  return readFailureModes();
});

define('findMatches', [], (issueId) => findMatches(issueId));

define('findHints', [], async (issueId) => {
  const budget = loadBudget();
  let current;
  let truncated = false;
  const candidates = [];
  try {
    current = await budget.run(() => readProperty(issueId, 'qualityloop'));
    if (current == null) return null;
    if (current.recordType !== 'NC' || !validDate(current.detectedDate)) return { applicable: false };
    if (![1, 2, 3].includes(current.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
    const seen = new Set([issueId]);
    // One capped page per query. Never use search totals or search snapshots as
    // evidence, and never let hint candidates enter the match/decision pipeline.
    for (const jql of buildHintJql(current)) {
      const response = await budget.run(() => api.asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST', headers,
        body: JSON.stringify({ jql, maxResults: HINT_CANDIDATE_LIMIT, fields: ['id'] }),
      }));
      if (response.status === 403 || response.status === 404) return null;
      checkJira(response);
      const data = await budget.run(() => response.json());
      if (data.isLast === false || data.nextPageToken || data.issues?.length > HINT_CANDIDATE_LIMIT) truncated = true;
      const issues = (data.issues ?? []).slice(0, HINT_CANDIDATE_LIMIT).filter(({ id }) => {
        const value = String(id);
        if (!/^\d+$/.test(value) || seen.has(value)) return false;
        seen.add(value);
        return true;
      });
      for (let offset = 0; offset < issues.length; offset += 5) {
        const fresh = await Promise.all(issues.slice(offset, offset + 5).map(async ({ id }) => {
          const response = await budget.run(() => api.asUser().requestJira(
            route`/rest/api/3/issue/${id}?fields=summary,status&properties=qualityloop`,
            { headers: { Accept: 'application/json' } },
          ));
          if (response.status === 403 || response.status === 404) return null;
          checkJira(response);
          const issue = await budget.run(() => response.json());
          const capture = issue.properties?.qualityloop;
          if (!capture || ![1, 2, 3].includes(capture.schemaVersion)) return null;
          return { ...capture, id: issue.id, key: issue.key, summary: issue.fields?.summary };
        }));
        candidates.push(...fresh.filter(Boolean));
      }
    }
    return { applicable: true, ...(truncated ? { incomplete: true, truncated: true } : {}), hints: selectHints({ ...current, id: issueId }, candidates) };
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    return { applicable: true, incomplete: true, budgetExceeded: true, ...(truncated ? { truncated: true } : {}),
      hints: current ? selectHints({ ...current, id: issueId }, candidates) : [] };
  }
});

define('saveCapture', CAPTURE_FIELDS, async (issueId, payload) => {
  // Read the issue with its property so a missing property is distinct from an
  // inaccessible issue (both can be 404 on the property endpoint).
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueId}?fields=summary&properties=qualityloop`,
    { headers: { Accept: 'application/json' } },
  );
  if (response.status === 403 || response.status === 404) return null;
  checkJira(response);
  const stored = (await response.json()).properties?.qualityloop;
  if (stored?.recordType && payload.recordType !== stored.recordType) {
    return { error: 'Record type cannot be changed after the first save. Create a new issue instead.' };
  }
  const catalogue = await readFailureModes(); // One authoritative read per save invocation.
  const fieldErrors = validateCapture(payload, catalogue.modes, stored?.failureMode);
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  const record = buildCapture(payload);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 32768) {
    return { error: 'The record exceeds the Jira issue property size limit.' };
  }
  if (!await writeProperty(issueId, 'qualityloop', record)) return null;
  return { record };
});

registerDecisionResolvers({ define, findMatches });

export const handler = resolver.getDefinitions();
