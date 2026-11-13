/* REAL benchmark preparation. Never invoked by the app or test suite.
 * Default: dry run. Writes require --execute (and an explicit benchmark label).
 * node scripts/seed-benchmark.js --count 1000 --label qualityloop-benchmark-scale1
 * node scripts/seed-benchmark.js --count 1000 --label qualityloop-benchmark-scale1 --execute
 * node scripts/seed-benchmark.js --cleanup --label qualityloop-benchmark-scale1 --execute
 */
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const cleanup = args.includes('--cleanup');
const execute = args.includes('--execute') && !args.includes('--dry-run');
const count = Number(option('--count') ?? 100);
const label = option('--label') ?? 'qualityloop-benchmark-preview';

async function main() {
  const allowed = new Set(['--count', '--label', '--cleanup', '--execute', '--dry-run']);
  for (let i = 0; i < args.length; i += 1) {
    if (!allowed.has(args[i])) throw new Error('Unknown option.');
    if (['--count', '--label'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing option value.');
      i += 1;
    }
  }
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('--count must be 1–10000.');
  if (!/^qualityloop-benchmark-[a-z0-9-]{1,60}$/.test(label)) throw new Error('Use a qualityloop-benchmark- label with lowercase letters, digits and hyphens.');
  if ((execute || cleanup) && !option('--label')) throw new Error('Supply the exact --label for this run.');
  const project = process.env.PROJECT_KEY;
  if (project && !/^[A-Z][A-Z0-9_]*$/.test(project)) throw new Error('Invalid PROJECT_KEY.');
  console.log(`${execute ? 'REAL' : 'DRY RUN'}: ${cleanup ? 'delete only labelled issues' : `create ${count} CAPAs`}; label=${label}; project=${project || '(PROJECT_KEY not set)'}`);
  if (!execute) {
    console.log('No network calls or writes. Set ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, JIRA_SITE and PROJECT_KEY in your environment; add --execute to run.');
    return;
  }
  const { ATLASSIAN_EMAIL: email, ATLASSIAN_API_TOKEN: token, JIRA_SITE: site } = process.env;
  if (!email || !token || !site || !project) throw new Error('Required benchmark environment variables are missing.');
  const url = new URL(site);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('JIRA_SITE must be an HTTPS Atlassian Cloud site origin.');
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
  async function jira(path, method = 'GET', body) {
    const response = await fetch(`${url.origin}${path}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(15000),
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}; stopped without retries. Inspect labelled issues before rerunning.`);
    return response.status === 204 ? null : response.json();
  }
  if (cleanup) {
    // Collect before deleting: changing the result set while paging can skip issues.
    const ids = new Set();
    let nextPageToken;
    do {
      const page = await jira('/rest/api/3/search/jql', 'POST', {
        jql: `project = "${project}" AND labels = "${label}" ORDER BY key ASC`,
        fields: ['labels', 'project'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}),
      });
      for (const issue of page.issues ?? []) {
        if (issue.fields?.project?.key === project && issue.fields?.labels?.includes(label) && /^\d+$/.test(issue.id)) ids.add(issue.id);
      }
      nextPageToken = page.isLast === true ? undefined : page.nextPageToken;
    } while (nextPageToken);
    let deleted = 0;
    for (const id of ids) {
      const current = await jira(`/rest/api/3/issue/${id}?fields=labels,project`);
      if (current.fields?.project?.key !== project || !current.fields?.labels?.includes(label)) continue;
      // No deleteSubtasks: never cascade into unlabelled issues.
      await jira(`/rest/api/3/issue/${id}`, 'DELETE');
      deleted += 1;
    }
    console.log(`Deleted ${deleted} labelled benchmark issues. Search indexing may lag; repeat the dry run/check before another cleanup.`);
    return;
  }
  let startAt = 0;
  let taskType;
  for (;;) {
    const page = await jira(`/rest/api/3/issue/createmeta/${project}/issuetypes?startAt=${startAt}&maxResults=200`);
    taskType = page.issueTypes?.find((type) => type.name === 'Task' && !type.subtask);
    startAt += page.issueTypes?.length ?? 0;
    if (taskType || !page.issueTypes?.length || startAt >= page.total) break;
  }
  if (!taskType) throw new Error('The throwaway project needs a standard Task issue type.');
  const closedDate = new Date(Date.now() - 86400000 * 30).toISOString().slice(0, 10);
  for (let i = 0; i < count; i += 1) {
    const partOriginal = i % 5 === 0 ? 'P-4471-A' : i % 5 === 1 ? 'P-4471-B' : `P-${9000 + i}-A`;
    const value = { schemaVersion: 2, recordType: 'CAPA', partOriginal, partNorm: partOriginal,
      partBase: partOriginal.slice(0, -2), partRevision: partOriginal.slice(-1), failureMode: 'FM-01',
      supplier: 'Benchmark supplier', line: 'Benchmark line', detectedDate: '', closedDate,
      rootCause: 'REAL benchmark fixture', actionsTaken: 'Benchmark only', effectivenessEvidenceUrl: '', updatedAt: new Date().toISOString() };
    await jira('/rest/api/3/issue', 'POST', { fields: { project: { key: project }, issuetype: { id: taskType.id },
      summary: `QualityLoop REAL benchmark CAPA ${i + 1}`, labels: [label] }, properties: [{ key: 'qualityloop', value }] });
    if ((i + 1) % 100 === 0 || i + 1 === count) console.log(`Created ${i + 1}/${count}; label=${label}`);
  }
}

main().catch(() => {
  // Never print a caught exception: network errors can contain headers/credentials.
  console.error('Benchmark stopped. Check options, required environment variables, project permissions and labelled issues before retrying. No automatic retries.');
  process.exitCode = 1;
});
