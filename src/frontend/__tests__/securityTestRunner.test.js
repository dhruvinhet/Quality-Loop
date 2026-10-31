import { runSecurityTests } from '../securityTestRunner';
import { JQL_SECURITY_PARTS } from '../../lib/securitySelfTest';

const settings = { currentIssueId: '10001', otherIssueId: '99999', restrictedIssue: 'HIDDEN-1', expectedWrite: 'browse' };
const read = (record) => ({ record, securityTest: { issueId: '10001', http: [{ operation: 'property GET', status: 200 }] } });
function successfulInvoke() {
  return jest.fn(async (name) => {
    if (name === 'loadCapture') return read({ partOriginal: 'P-1' });
    if (name === 'findMatches') return { ...read(undefined), applicable: true, strong: [], elapsedMs: Math.random() };
    if (name === 'probeIssueAccess') return { status: 404, hasSummary: false };
    if (name === 'probeJqlEscaping') return { results: JQL_SECURITY_PARTS.map((partBase) => ({ partBase, status: 200 })) };
    if (name === 'saveCapture') return { securityTest: { http: [{ operation: 'save PUT', status: 403 }], restored: true } };
    throw new Error(`Unexpected resolver: ${name}`);
  });
}

test('runs baseline and injected calls, restricted read, JQL probes and existing save resolver sequentially', async () => {
  const invoke = successfulInvoke();
  const rows = [];
  await runSecurityTests({ ...settings, invoke, onRow: (row) => rows.push(row) });
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['loadCapture', 'loadCapture', 'findMatches', 'findMatches', 'probeIssueAccess', 'probeJqlEscaping', 'saveCapture']);
  expect(invoke.mock.calls[1][1]).toEqual({ securityTest: true, issueId: '99999' });
  expect(invoke.mock.calls[3][1]).toEqual({ securityTest: true, issueId: '99999' });
  expect(invoke.mock.calls.at(-1)).toEqual(['saveCapture', expect.objectContaining({ securityTest: true, partNumber: 'SECURITY SELF TEST' })]);
  expect(rows).toHaveLength(8);
  expect(rows.every(({ pass }) => pass)).toBe(true);
  expect(rows[0].detail).toContain('10001');
});

test('failed reads, syntax errors and a successful browse-only write cannot masquerade as PASS', async () => {
  const invoke = jest.fn(async (name) => {
    if (name === 'loadCapture') return null;
    if (name === 'findMatches') throw new Error('Bridge request failed');
    if (name === 'probeIssueAccess') return { status: 200, hasSummary: true };
    if (name === 'probeJqlEscaping') return { results: JQL_SECURITY_PARTS.map((partBase) => ({ partBase, status: 400 })) };
    return { securityTest: { http: [{ operation: 'save PUT', status: 200 }], restored: true } };
  });
  const rows = [];
  await runSecurityTests({ ...settings, invoke, onRow: (row) => rows.push(row) });
  expect(rows.every(({ pass }) => !pass)).toBe(true);
  expect(rows.find(({ check }) => check.includes('findMatches')).detail).toBe('Bridge request failed');
  expect(invoke.mock.calls.at(-1)[0]).toBe('saveCapture');
});

test('same/invalid injected issue ID fails the injection checks without issuing their reads', async () => {
  const invoke = successfulInvoke();
  const rows = [];
  await runSecurityTests({ ...settings, otherIssueId: '10001', invoke, onRow: (row) => rows.push(row) });
  expect(rows.slice(0, 2).every(({ pass }) => !pass)).toBe(true);
  expect(invoke.mock.calls.some(([name]) => ['findMatches', 'loadCapture'].includes(name))).toBe(false);
});

test('read-only direct probe response never includes the actual summary in displayed results', async () => {
  const invoke = successfulInvoke();
  const rows = [];
  const base = invoke.getMockImplementation();
  invoke.mockImplementation(async (name, payload) => name === 'loadCapture'
    ? { ...read({ partOriginal: 'P-1' }), unrelatedSummary: 'Readable capture detail' } : base(name, payload));
  await runSecurityTests({ ...settings, invoke, onRow: (row) => rows.push(row) });
  expect(JSON.stringify(rows)).not.toContain('Readable capture detail');
});
