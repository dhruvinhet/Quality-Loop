import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { buildCapture, CAPTURE_FIELDS, validateCapture, validDate } from '../lib/capture';
import { matchCaptures } from '../lib/match';
import { buildMatchJql } from '../lib/matchJql';
import { buildHintJql } from '../lib/hintJql';
import { HINT_CANDIDATE_LIMIT, selectHints } from '../lib/hints';
import { registerDecisionResolvers } from './decisions';

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
    } catch {
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
  if (!response.ok) throw new Error(`Property GET returned HTTP ${response.status}`);
  return (await response.json()).value;
}

async function writeProperty(issueId, propertyKey, value) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`,
    { method: 'PUT', headers, body: JSON.stringify(value) },
  );
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Property PUT returned HTTP ${response.status}`);
  return true;
}

define('loadCapture', [], async (issueId) => {
  const record = await readProperty(issueId, 'qualityloop');
  if (record == null) return null;
  if (![1, 2].includes(record.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
  return { record };
});

async function findMatches(issueId) {
  const started = Date.now();
  const current = await readProperty(issueId, 'qualityloop');
  if (current == null) return null;
  if (current.recordType !== 'NC' || !validDate(current.detectedDate)) return { applicable: false };
  if (![1, 2].includes(current.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
  const jql = buildMatchJql(current);
  const candidates = [];
  const seen = new Set();
  let nextPageToken;
  do {
    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST', headers,
      body: JSON.stringify({ jql, maxResults: 50, fields: ['summary', 'status'],
        properties: ['qualityloop'], ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Match search returned HTTP ${response.status}`);
    const data = await response.json();
    const issues = (data.issues ?? []).filter(({ id }) => /^\d+$/.test(String(id)) && String(id) !== issueId && !seen.has(String(id)));
    // Bound concurrency; use fresh metadata AND property rather than search snapshots.
    for (let offset = 0; offset < issues.length; offset += 5) {
      const fresh = await Promise.all(issues.slice(offset, offset + 5).map(async ({ id }) => {
        seen.add(String(id));
        const result = await api.asUser().requestJira(
          route`/rest/api/3/issue/${id}?fields=summary,status&properties=qualityloop`,
          { headers: { Accept: 'application/json' } },
        );
        if (result.status === 403 || result.status === 404) return null;
        if (!result.ok) throw new Error(`Candidate GET returned HTTP ${result.status}`);
        const issue = await result.json();
        const capture = issue.properties?.qualityloop;
        if (!capture || ![1, 2].includes(capture.schemaVersion)) return null;
        return { ...capture, id: issue.id, key: issue.key, summary: issue.fields?.summary, status: issue.fields?.status?.name };
      }));
      candidates.push(...fresh.filter(Boolean));
    }
    nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
  } while (nextPageToken);
  return { applicable: true, ...matchCaptures({ ...current, id: issueId }, candidates), elapsedMs: Date.now() - started };
}
define('findMatches', [], findMatches);

define('findHints', [], async (issueId) => {
  const current = await readProperty(issueId, 'qualityloop');
  if (current == null) return null;
  if (current.recordType !== 'NC' || !validDate(current.detectedDate)) return { applicable: false };
  if (![1, 2].includes(current.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
  const candidates = [];
  const seen = new Set([issueId]);
  // One capped page per query. Never use search totals or search snapshots as
  // evidence, and never let hint candidates enter the match/decision pipeline.
  for (const jql of buildHintJql(current)) {
    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST', headers,
      body: JSON.stringify({ jql, maxResults: HINT_CANDIDATE_LIMIT, fields: ['id'] }),
    });
    if (response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw new Error(`Hint search returned HTTP ${response.status}`);
    const data = await response.json();
    const issues = (data.issues ?? []).slice(0, HINT_CANDIDATE_LIMIT).filter(({ id }) => {
      const value = String(id);
      if (!/^\d+$/.test(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
    for (let offset = 0; offset < issues.length; offset += 5) {
      const fresh = await Promise.all(issues.slice(offset, offset + 5).map(async ({ id }) => {
        const response = await api.asUser().requestJira(
          route`/rest/api/3/issue/${id}?fields=summary,status&properties=qualityloop`,
          { headers: { Accept: 'application/json' } },
        );
        if (response.status === 403 || response.status === 404) return null;
        if (!response.ok) throw new Error(`Hint candidate GET returned HTTP ${response.status}`);
        const issue = await response.json();
        const capture = issue.properties?.qualityloop;
        if (!capture || ![1, 2].includes(capture.schemaVersion)) return null;
        return { ...capture, id: issue.id, key: issue.key, summary: issue.fields?.summary };
      }));
      candidates.push(...fresh.filter(Boolean));
    }
  }
  return { applicable: true, hints: selectHints({ ...current, id: issueId }, candidates) };
});

define('saveCapture', CAPTURE_FIELDS, async (issueId, payload) => {
  const fieldErrors = validateCapture(payload);
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
