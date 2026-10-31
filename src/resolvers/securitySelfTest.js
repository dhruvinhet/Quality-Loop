import api, { route } from '@forge/api';
import { SEC_TEST } from '../config/devFlags';
import { buildMatchJql } from '../lib/matchJql';
import { JQL_SECURITY_PARTS, sameJson } from '../lib/securitySelfTest';

const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
const enabled = () => { if (!SEC_TEST) throw new Error('Security self-test is disabled.'); };

export async function probeIssueAccess(issueIdOrKey) {
  enabled();
  if (typeof issueIdOrKey !== 'string' || !/^(?:\d+|[A-Za-z][A-Za-z0-9_]*-\d+)$/.test(issueIdOrKey)) throw new Error('Enter an issue ID or key.');
  // This GET is the authorisation check for the payload ID. Never return its body.
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=summary`, { headers });
  return { status: response.status, hasSummary: response.ok && typeof (await response.json()).fields?.summary === 'string' };
}

export async function probeJqlEscaping() {
  enabled();
  const results = [];
  for (const partOriginal of JQL_SECURITY_PARTS) {
    const jql = buildMatchJql({ partOriginal, failureMode: 'FM-01', detectedDate: '2026-10-31' });
    try {
      const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST', headers, body: JSON.stringify({ jql, maxResults: 1, fields: ['id'] }),
      });
      // Neither issue IDs, counts nor titles from this search leave the resolver.
      results.push({ partBase: partOriginal, status: response.status });
    } catch (error) {
      results.push({ partBase: partOriginal, error: error.message });
    }
  }
  return { results };
}

// Invoked ONLY through the existing saveCapture resolver's explicit dev mode.
// Snapshot/restore stay in this invocation even if the panel is closed.
export async function restoringSave(issueId, save, trace) {
  enabled();
  const request = async (operation, options = {}) => {
    const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}/properties/qualityloop`, { headers, ...options });
    trace.http.push({ operation, status: response.status });
    return response;
  };
  let previous;
  let existed;
  let attempted = false;
  try {
    // Disambiguate missing property from inaccessible current issue before writing.
    const access = await probeIssueAccess(issueId);
    trace.http.push({ operation: 'current issue GET', status: access.status });
    if (access.status !== 200) return { securityTest: { ...trace, error: 'Current issue could not be authorised.' } };
    const snapshot = await request('snapshot GET');
    if (![200, 404].includes(snapshot.status)) throw new Error(`Snapshot GET returned HTTP ${snapshot.status}`);
    existed = snapshot.status === 200;
    if (existed) previous = (await snapshot.json()).value;
    // Reuse the snapshot's editable fields through the normal validation/build/PUT.
    attempted = true;
    const result = await save(existed ? previous : null);
    if (result?.error || result?.fieldErrors) {
      trace.error = result.error || JSON.stringify(result.fieldErrors);
      attempted = false; // Validation failed before PUT; nothing to restore.
    }
  } catch (error) {
    trace.error = error.message;
  } finally {
    const saved = trace.http.find(({ operation }) => operation === 'save PUT');
    // A transport failure may have committed the write. Attempt restoration too.
    const needsRestore = attempted && (!saved || [200, 201].includes(saved.status) || saved.status >= 500);
    if (needsRestore) {
      try {
        const restored = await request(existed ? 'restore PUT' : 'restore DELETE', existed
          ? { method: 'PUT', body: JSON.stringify(previous) } : { method: 'DELETE' });
        if (!restored.ok) throw new Error(`Restore returned HTTP ${restored.status}`);
        const verification = await request('restore GET');
        trace.restored = existed ? verification.status === 200 && sameJson((await verification.json()).value, previous) : verification.status === 404;
        if (!trace.restored) throw new Error('Previous property was not restored. Check the current issue immediately.');
      } catch (error) {
        trace.restored = false;
        trace.error = error.message;
      }
    } else if (attempted) {
      trace.restored = [403, 404].includes(saved?.status);
    }
  }
  return { securityTest: trace };
}
