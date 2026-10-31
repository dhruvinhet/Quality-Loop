import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { E1_PROBE } from '../config/devFlags';
import { buildCapture, CAPTURE_FIELDS, validateCapture } from '../lib/capture';

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

// No issue identifiers are accepted in payloads, even when the context is present.
function define(name, fields, fn, probe = false) {
  resolver.define(name, async (req) => {
    try {
      if (probe && !E1_PROBE) return { error: 'E1 probe is disabled.' };
      allowFields(req.payload ?? {}, fields);
      return await fn(issueFromContext(req), req.payload ?? {});
    } catch (error) {
      console.error(`QualityLoop ${name}:`, error.message);
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
  if (record.schemaVersion !== 1) return { error: 'This record uses an unsupported schema version.' };
  return { record };
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

export const handler = resolver.getDefinitions();
