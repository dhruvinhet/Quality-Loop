import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { E1_PROBE, SEC_TEST } from '../config/devFlags';
import { buildCapture, CAPTURE_FIELDS, validateCapture, validDate } from '../lib/capture';
import { matchCaptures } from '../lib/match';
import { buildMatchJql } from '../lib/matchJql';
import { buildHintJql } from '../lib/hintJql';
import { HINT_CANDIDATE_LIMIT, selectHints } from '../lib/hints';
import { probeIssueAccess, probeJqlEscaping, restoringSave } from './securitySelfTest';
import { securityCapturePayload } from '../lib/securitySelfTest';
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

// Capture/match requests reject issue identifiers. SEC_TEST reads discard an
// injected ID so the developer can compare the authorised source IDs live.
function define(name, fields, fn, probe = false) {
  resolver.define(name, async (req) => {
    try {
      if (probe === 'security' && !SEC_TEST) return { error: 'Security self-test is disabled.' };
      if (probe === true && !E1_PROBE) return { error: 'E1 probe is disabled.' };
      const payload = req.payload ?? {};
      if (Object.hasOwn(payload, 'securityTest') && !SEC_TEST) return { error: 'Security self-test is disabled.' };
      const testing = SEC_TEST && payload.securityTest === true && ['loadCapture', 'findMatches', 'saveCapture'].includes(name);
      allowFields(payload, testing ? [...fields, 'securityTest', ...(['loadCapture', 'findMatches'].includes(name) ? ['issueId'] : [])] : fields);
      const issueId = issueFromContext(req);
      const trace = testing ? { issueId, http: [] } : undefined;
      if (testing && name === 'saveCapture') {
        return await restoringSave(issueId, (previous) => fn(issueId, securityCapturePayload(previous), trace), trace);
      }
      const result = await fn(issueId, payload, trace, req.context);
      // Preserve null on denied/missing reads; never attach a source ID to a denial.
      return trace && result && !result.error ? { ...result, securityTest: trace } : result;
    } catch (error) {
      console.error(`QualityLoop ${name}:`, error.message);
      if (SEC_TEST && (probe === 'security' || req.payload?.securityTest === true)) return { error: error.message };
      return { error: 'QualityLoop could not complete the request. Reopen the panel and try again.' };
    }
  });
}

async function readProperty(issueId, propertyKey, trace) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`,
    { headers: { Accept: 'application/json' } },
  );
  trace?.http.push({ operation: 'property GET', status: response.status });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Property GET returned HTTP ${response.status}`);
  return (await response.json()).value;
}

async function writeProperty(issueId, propertyKey, value, trace) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueId}/properties/${propertyKey}`,
    { method: 'PUT', headers, body: JSON.stringify(value) },
  );
  trace?.http.push({ operation: 'save PUT', status: response.status });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Property PUT returned HTTP ${response.status}`);
  return true;
}

define('loadCapture', [], async (issueId, payload, trace) => {
  const record = await readProperty(issueId, 'qualityloop', trace);
  if (record == null) return null;
  if (![1, 2].includes(record.schemaVersion)) return { error: 'This record uses an unsupported schema version.' };
  return { record };
});

async function findMatches(issueId, payload, trace) {
  const started = Date.now();
  const current = await readProperty(issueId, 'qualityloop', trace);
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
    trace?.http.push({ operation: 'match POST', status: response.status });
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
        return { ...capture, id: issue.id, key: issue.key };
      }));
      candidates.push(...fresh.filter(Boolean));
    }
  }
  return { applicable: true, hints: selectHints({ ...current, id: issueId }, candidates) };
});

define('saveCapture', CAPTURE_FIELDS, async (issueId, payload, trace) => {
  const fieldErrors = validateCapture(payload);
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  const record = buildCapture(payload);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 32768) {
    return { error: 'The record exceeds the Jira issue property size limit.' };
  }
  if (!await writeProperty(issueId, 'qualityloop', record, trace)) return null;
  return { record };
});

function probeToken(payload) {
  if (typeof payload.token !== 'string' || !/^E1-\d{13,16}-(?:[1-9]|1\d|20)$/.test(payload.token)) {
    throw new Error('Invalid E1 token.');
  }
  return payload.token;
}

define('probeWrite', ['token'], async (issueId, payload) => {
  const token = probeToken(payload);
  const started = Date.now();
  if (!await writeProperty(issueId, 'qualityloop-probe', { token })) return null;
  return { writeMs: Date.now() - started };
}, true);

define('probeRead', ['token'], async (issueId, payload) => {
  const token = probeToken(payload);
  const value = await readProperty(issueId, 'qualityloop-probe');
  if (value == null) return null;
  return { readbackOk: value.token === token };
}, true);

define('probeSearch', ['token'], async (issueId, payload) => {
  const token = probeToken(payload);
  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers,
    body: JSON.stringify({
      jql: `qlProbeToken = "${token}" AND issue = ${issueId}`,
      maxResults: 1,
      fields: ['id'],
      // Deliberately no reconcileIssues: E1 measures ordinary index visibility.
    }),
  });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Probe search returned HTTP ${response.status}`);
  const data = await response.json();
  return { hit: (data.issues ?? []).some((issue) => String(issue.id) === issueId) };
}, true);

define('probeIssueAccess', ['issueIdOrKey'], (issueId, payload) => probeIssueAccess(payload.issueIdOrKey), 'security');
define('probeJqlEscaping', [], () => probeJqlEscaping(), 'security');

registerDecisionResolvers({ define, findMatches });

export const handler = resolver.getDefinitions();
