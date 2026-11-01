const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../../../scripts/eval-predict.js');
let fixture;

beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'qualityloop-eval-'));
});

afterEach(() => {
  const target = path.resolve(fixture);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('qualityloop-eval-')) {
    throw new Error('Unexpected fixture cleanup path.');
  }
  rmSync(target, { recursive: true, force: true });
});

const writeJson = (name, value) => writeFileSync(path.join(fixture, name), JSON.stringify(value));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: fixture, encoding: 'utf8' });

test('CLI uses shipped matching, CAPA ids and only NC inputs, with no Forge runtime', () => {
  mkdirSync(path.join(fixture, 'inputs'));
  const signature = { part: ' bracket  4471-a ', failureMode: 'FM-01', supplier: 'S1', line: 'L1' };
  writeJson('inputs/ncs.json', { ncs: [
    { ...signature, id: 'NC-example', detectedDate: '2026-10-31' },
    { ...signature, id: 'NC-empty', part: 'OTHER', detectedDate: '2026-10-31' },
  ] });
  // If the harness starts parsing labels, this deliberately invalid JSON fails.
  writeFileSync(path.join(fixture, 'inputs/labels.json'), 'not JSON');
  const candidate = (id, extra = {}) => ({
    ...signature, id, summary: 'A summary, not an id', part: 'BRACKET 4471-A',
    closedDate: '2026-10-01', jiraStatus: 'Reopened',
    dataNote: 'Must not change classification', ...extra,
  });
  writeJson('corpus.json', { capas: [
    candidate('CAPA-exact', { supplier: 'S2', line: 'L2' }),
    candidate('CAPA-revision', { part: 'BRACKET 4471-B' }),
    candidate('CAPA-same-day', { closedDate: '2026-10-31' }),
    candidate('CAPA-boundary', { closedDate: '2025-10-31' }),
    candidate('CAPA-too-old', { closedDate: '2025-10-30' }),
    candidate('CAPA-future', { closedDate: '2026-11-01' }),
    candidate('CAPA-no-date', { closedDate: null, jiraStatus: 'Done' }),
    candidate('CAPA-other-mode', { failureMode: 'FM-02' }),
  ] });
  const result = run('--data', 'inputs', '--corpus', 'corpus.json', '--out', 'out/predictions.json');
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(path.join(fixture, 'out/predictions.json'), 'utf8'))).toEqual({
    'NC-example': { strong: ['CAPA-exact', 'CAPA-boundary'], relatedRevision: ['CAPA-revision'] },
    'NC-empty': { strong: [], relatedRevision: [] },
  });
});

test('CLI fails clearly when a required flag is missing', () => {
  const result = run('--data', 'inputs');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Usage: node scripts/eval-predict.js');
});
