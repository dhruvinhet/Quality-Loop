import { compareSourceIssue, securityCapturePayload, writePassed } from '../lib/securitySelfTest';

const describe = (value) => value == null ? 'No data returned (missing property or access refused).' : JSON.stringify(value);
const diagnostics = (result) => result?.securityTest ?? result?.error ?? (result?.fieldErrors ? result : null);

export async function runSecurityTests({ invoke, currentIssueId, otherIssueId, restrictedIssue, expectedWrite, onRow }) {
  const check = async (name, work) => {
    try { onRow({ check: name, ...await work() }); }
    catch (error) { onRow({ check: name, pass: false, detail: error.message }); }
  };
  for (const name of ['loadCapture', 'findMatches']) {
    await check(`Payload ID injection: ${name}`, async () => {
      if (!/^\d+$/.test(otherIssueId) || currentIssueId === otherIssueId) throw new Error('Enter a different numeric issue ID.');
      const baseline = await invoke(name, { securityTest: true });
      const injected = await invoke(name, { securityTest: true, issueId: otherIssueId });
      return { pass: compareSourceIssue(baseline, injected, currentIssueId, otherIssueId),
        detail: `current=${currentIssueId}; injected=${otherIssueId}; baseline=${describe(diagnostics(baseline))}; injected result=${describe(diagnostics(injected))}. Source IDs and returned evidence must agree. Save quality details first if no data is returned.` };
    });
  }
  await check('Direct read by ID (expected restricted)', async () => {
    const result = await invoke('probeIssueAccess', { issueIdOrKey: restrictedIssue });
    return { pass: [403, 404].includes(result?.status) && result.hasSummary === false, detail: describe(result) };
  });
  await check('JQL escaping', async () => {
    const result = await invoke('probeJqlEscaping');
    if (result?.results?.length === 3) {
      for (const row of result.results) onRow({ check: `JQL escaping: ${row.partBase}`, pass: row.status === 200, detail: describe(row) });
    }
    return { pass: result?.results?.length === 3 && result.results.every(({ status }) => status === 200), detail: describe(result) };
  });
  // Last: avoid testing search equality across our own temporary write/index update.
  await check('Write attempt and restoration', async () => {
    const result = await invoke('saveCapture', { ...securityCapturePayload(null), securityTest: true });
    return { pass: writePassed(result, expectedWrite), detail: `Expected ${expectedWrite === 'browse' ? '403 refusal' : '200/201 and exact restoration'}; ${describe(diagnostics(result))}` };
  });
}
