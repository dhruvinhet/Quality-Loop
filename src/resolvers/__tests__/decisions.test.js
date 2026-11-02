jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.mock('../decisionStore', () => ({ commitDecision: jest.fn(), getPairState: jest.fn(), queryRecords: jest.fn(), pairConfirmed: jest.fn(), PAIR_ENTITY: "pair-state", DECISION_ENTITY: "decision",
  readDecision: jest.fn(), claimTask: jest.fn(), saveTaskMetadata: jest.fn() }));

const api = require('@forge/api').default;
const store = require('../decisionStore');
const { handler } = require('../index');
const requestJira = jest.fn();
const context = { accountId: 'server-account', extension: { issue: { id: '10001' } } };
const nc = { schemaVersion: 2, recordType: 'NC', partOriginal: 'P-4471-A', failureMode: 'FM-01', detectedDate: '2026-10-31' };
const capa = { ...nc, recordType: 'CAPA', closedDate: '2026-10-01', effectivenessEvidenceUrl: 'https://example.com/evidence' };
const project = { id: '123', key: 'QL' };
const issue = (id, capture = capa) => ({ id, key: `QL-${id}`, properties: { qualityloop: capture },
  fields: { summary: `Summary ${id}`, project, status: { name: 'Done' } } });
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: jest.fn(async () => value) });
const payload = { capaId: '20002', expectedVersion: 0, type: 'CONFIRM', reason: 'Review evidence', evidenceLinks: [] };
const decisionId = '20002:10001:1793400000000-12345678-1234-1234-1234-123456789abc';
const concern = { issueId: '10001', capaId: '20002', type: 'CONCERN', reason: 'Review evidence',
  authorAccountId: 'server-account', evidenceLinks: [], createdAt: '2026-10-31T12:00:00.000Z' };
const followup = { capaId: '20002', decisionId, confirmation: "Create task in QL: 'Effectiveness re-review: QL-20002' and link it to QL-20002" };
let edit;
let create;
let hidden;
let captured;
let current;
let searchIds;
let createStatus;
let linkStatus;
beforeEach(() => {
  jest.clearAllMocks();
  api.asUser.mockReturnValue({ requestJira });
  edit = true; create = true; hidden = new Set(); captured = capa; current = nc; searchIds = ['20002']; createStatus = 201; linkStatus = 201;
  requestJira.mockImplementation(async (path, options) => {
    if (path.includes('mypermissions')) return response(200, { permissions: {
      EDIT_ISSUES: { havePermission: edit }, CREATE_ISSUES: { havePermission: create } } });
    if (path === '/rest/api/3/issue/10001/properties/qualityloop') return response(200, { value: current });
    if (path === '/rest/api/3/search/jql') return response(200, { issues: searchIds.map((id) => issue(id, captured)), isLast: true });
    if (path.startsWith('/rest/api/3/user?')) return response(200, { displayName: 'Engineer' });
    if (path.startsWith('/rest/api/3/issue/createmeta/')) return response(200, { issueTypes: [{ id: '987', name: 'Task', subtask: false }], total: 1 });
    if (path === '/rest/api/3/issueLinkType') return response(200, { issueLinkTypes: [{ id: 'relates-id', inward: 'relates to', outward: 'relates to' }] });
    if (path === '/rest/api/3/issue' && options.method === 'POST') return response(createStatus, { id: '30003', key: 'QL-30003' });
    if (path === '/rest/api/3/issueLink') return response(linkStatus);
    const id = path.match(/^\/rest\/api\/3\/issue\/([^?]+)/)?.[1];
    if (hidden.has(id)) return response(403, { secret: 'hidden' });
    if (id) return response(200, issue(id, id === '10001' ? current : captured));
    throw new Error(`Unexpected API path ${path}`);
  });
  store.getPairState.mockResolvedValue({ version: 0, state: 'NONE' });
  store.commitDecision.mockResolvedValue({ success: true });
  store.queryRecords.mockResolvedValue({ records: [], incomplete: false });
  store.pairConfirmed.mockImplementation(async (state) => state.confirmed === true);
  store.readDecision.mockResolvedValue(concern);
  store.claimTask.mockResolvedValue({ ...concern, taskClaimId: 'claim' });
  store.saveTaskMetadata.mockResolvedValue();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('panel loads EDIT_ISSUES in current issue context and non-editors receive read-only access', async () => {
  edit = false;
  expect(await handler.getPanelAccess({ context })).toEqual({ canEdit: false });
  expect(requestJira.mock.calls.map(([path]) => path)).toContain('/rest/api/3/mypermissions?issueId=10001&permissions=EDIT_ISSUES');
  hidden.add('10001');
  expect(await handler.getPanelAccess({ context })).toBeNull();
});
test('decision uses context identity and fresh strong matching before committing', async () => {
  expect(await handler.recordDecision({ context, payload })).toEqual({ success: true });
  expect(store.commitDecision).toHaveBeenCalledWith(expect.objectContaining({ issueId: '10001', authorAccountId: 'server-account',
    capa: expect.objectContaining({ id: '20002' }), payload }));
  expect(requestJira.mock.calls.map(([path]) => path)).not.toContain('/rest/api/3/search/jql');
  expect(requestJira).toHaveBeenCalledTimes(3);
});
test.each(['issueId', 'authorAccountId', 'createdAt', 'state'])('rejects client %s before APIs or storage', async (field) => {
  expect(await handler.recordDecision({ context, payload: { ...payload, [field]: 'injected' } })).toHaveProperty('error');
  expect(requestJira).not.toHaveBeenCalled();
  expect(store.commitDecision).not.toHaveBeenCalled();
});
test('refuses absent account context, non-editors, non-NCs, stale versions and nonmatching CAPAs', async () => {
  expect(await handler.recordDecision({ context: { extension: context.extension }, payload })).toHaveProperty('error');
  edit = false;
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  edit = true; current = { ...nc, recordType: 'CAPA' };
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  current = nc; captured = { ...capa, failureMode: 'FM-02' };
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  captured = capa; store.getPairState.mockResolvedValue({ version: 2, state: 'CONFIRMED' });
  expect(await handler.recordDecision({ context, payload })).toEqual({ conflict: true, pairState: { version: 2, state: 'CONFIRMED' } });
  expect(store.commitDecision).not.toHaveBeenCalled();
});
test('related revision is allowed but other related is refused', async () => {
  captured = { ...capa, partOriginal: 'P-4471-B' };
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('success', true);
  store.commitDecision.mockClear(); captured = { ...capa, failureMode: 'FM-02' };
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  expect(store.commitDecision).not.toHaveBeenCalled();
});

test.each([
  { partOriginal: 'P-4741-A' }, { closedDate: null }, { closedDate: '2025-10-30' },
])('hint candidates cannot receive decisions: %j', async (fields) => {
  captured = { ...capa, ...fields };
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  expect(store.commitDecision).not.toHaveBeenCalled();
});
test('CAPA denial returns nothing and no stored pair information', async () => {
  hidden.add('20002');
  expect(await handler.recordDecision({ context, payload })).toBeNull();
  expect(store.getPairState).not.toHaveBeenCalled();
});
test('CONCERN eligibility is enforced before any write', async () => {
  expect(await handler.recordDecision({ context, payload: { ...payload, type: 'CONCERN' } })).toHaveProperty('error');
  expect(store.commitDecision).not.toHaveBeenCalled();
  store.getPairState.mockResolvedValue({ version: 1, state: 'CONFIRMED' });
  expect(await handler.recordDecision({ context, payload: { ...payload, type: 'CONCERN', expectedVersion: 1 } })).toHaveProperty('success');
});
test('history filters hidden CAPAs; aggregate counts also filter hidden NCs', async () => {
  hidden.add('20004'); hidden.add('10009');
  store.queryRecords.mockImplementation(async (entity, index) => ({ records: entity === 'decision'
    ? [{ ...concern, id: decisionId, type: 'CONFIRM' }]
    : index === 'by-issue' ? [{ capaId: '20002', issueId: '10001' }, { capaId: '20004', issueId: '10001' }]
      : [{ capaId: '20002', issueId: '10001' }, { capaId: '20002', issueId: '10009' }], incomplete: false }));
  store.getPairState.mockResolvedValue({ version: 10, state: 'CONFIRMED', confirmed: true });
  const result = await handler.getDecisions({ context });
  expect(Object.keys(result.pairs)).toEqual(['20002']);
  expect(result.pairs['20002']).toMatchObject({ confirmedCount: 1, history: [{ authorDisplayName: 'Engineer' }] });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|10009|20004|server-account/);
});
test('direct latest-decision read fills an index-lag gap in history', async () => {
  store.getPairState.mockResolvedValue({ version: 1, state: 'CONCERN_RAISED', latestDecisionId: decisionId });
  const result = await handler.getDecisions({ context });
  expect(result.pairs['20002'].history).toMatchObject([{ id: decisionId, reason: concern.reason }]);
});
test('50 newest decisions per pair are displayed with an older-history notice', async () => {
  store.queryRecords.mockImplementation(async (entity) => ({ records: entity === 'decision'
    ? Array.from({ length: 51 }, (_, i) => ({ ...concern, id: `decision-${String(i).padStart(2, '0')}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() })) : [], incomplete: false }));
  const result = await handler.loadEvidence({ context });
  expect(result.pairs['20002'].history).toHaveLength(50);
  expect(result.pairs['20002'].history[0].id).toBe('decision-50');
  expect(result.pairs['20002'].history.at(-1).id).toBe('decision-01');
  expect(result.pairs['20002'].historyIncomplete).toBe(true);
});
test.each([
  [true, 1], [false, 0],
])('pair state confirmed=%s counts one distinct visible NC as %i regardless of repeated events', async (confirmed, count) => {
  store.getPairState.mockResolvedValue({ version: 10, state: 'CONCERN_RAISED', confirmed });
  store.queryRecords.mockImplementation(async (entity, index) => ({ records: entity === 'decision' ? Array.from({ length: 10 }, (_, i) => ({ ...concern, id: `d${i}`, type: 'CONFIRM' }))
    : index === 'by-capa' ? [{ capaId: '20002', issueId: '10001' }, { capaId: '20002', issueId: '10001' }] : [], incomplete: false }));
  const result = await handler.loadEvidence({ context });
  expect(result.pairs['20002'].confirmedCount).toBe(count);
});
test('50+ requires 51 authorised currently confirmed NCs; hidden pairs never manufacture 50+', async () => {
  store.getPairState.mockResolvedValue({ version: 1, state: 'CONFIRMED', confirmed: true });
  store.queryRecords.mockImplementation(async (entity, index) => ({ records: entity === 'pair-state' && index === 'by-capa'
    ? Array.from({ length: 51 }, (_, i) => ({ capaId: '20002', issueId: String(11000 + i) })) : [], incomplete: true }));
  expect((await handler.loadEvidence({ context })).pairs['20002'].confirmedCount).toBe('50+');
  hidden.add('11050');
  const limited = (await handler.loadEvidence({ context })).pairs['20002'];
  expect(limited).toMatchObject({ confirmedCount: 50, confirmedCountIncomplete: true });
});
test('unbrowsable current issue returns no history or counts and never queries storage', async () => {
  hidden.add('10001');
  expect(await handler.getDecisions({ context })).toBeNull();
  expect(store.queryRecords).not.toHaveBeenCalled();
});
test('prepare only lists writes; creating a task requires the exact confirmed listing', async () => {
  expect(await handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } })).toEqual({ confirmation: followup.confirmation });
  expect(store.claimTask).not.toHaveBeenCalled();
  expect(await handler.createConcernTask({ context, payload: { ...followup, confirmation: 'yes' } })).toHaveProperty('error');
  expect(store.claimTask).not.toHaveBeenCalled();
});
test('no create permission retains the recorded concern and shows the specified message', async () => {
  create = false;
  expect(await handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } }))
    .toEqual({ message: "Recorded. You can't create tasks in QL; ask the CAPA owner to review." });
  expect(store.claimTask).not.toHaveBeenCalled();
});
test('confirmed follow-up creates a project-specific Task and relates-to link asUser', async () => {
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('message', 'Recorded. Created QL-30003 and linked it to QL-20002.');
  const post = requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issue');
  expect(JSON.parse(post[1].body)).toEqual({ fields: { project: { id: '123' }, issuetype: { id: '987' }, summary: 'Effectiveness re-review: QL-20002' } });
  expect(store.saveTaskMetadata).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskKey: 'QL-30003', reason: concern.reason }));
  const link = requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issueLink');
  expect(JSON.parse(link[1].body)).toEqual({ type: { id: 'relates-id' }, outwardIssue: { id: '30003' }, inwardIssue: { id: '20002' } });
});
test('task creation or linking errors preserve the concern and expose the separate error', async () => {
  createStatus = 400;
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('error', expect.stringMatching(/Recorded.*HTTP 400/));
  expect(store.commitDecision).not.toHaveBeenCalled();
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  createStatus = 201; linkStatus = 403;
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('error', expect.stringContaining('Follow-up linking could not finish'));
  expect(store.saveTaskMetadata).toHaveBeenCalled();
});

test.each([403, 404])('payload CAPA HTTP %s returns nothing before reading stored pair data', async (status) => {
  requestJira.mockResolvedValue(response(status, { secret: 'hidden' }));
  for (const name of ['recordDecision', 'prepareConcernTask', 'createConcernTask']) {
    const result = await handler[name]({ context, payload: name === 'recordDecision' ? payload
      : name === 'prepareConcernTask' ? { capaId: '20002', decisionId } : followup });
    expect(result).toBeNull();
  }
  expect(store.getPairState).not.toHaveBeenCalled();
  expect(store.readDecision).not.toHaveBeenCalled();
  expect(store.claimTask).not.toHaveBeenCalled();
});

test('follow-up infrastructure exceptions log no values and return no task identifiers', async () => {
  store.saveTaskMetadata.mockRejectedValue(new Error('SECRET task fields https://private/evidence'));
  const result = await handler.createConcernTask({ context, payload: followup });
  expect(result).toEqual({ error: 'Recorded. Follow-up could not finish. Check Jira before creating another task.' });
  expect(JSON.stringify([result, console.error.mock.calls])).not.toMatch(/SECRET|private|QL-30003|stack/);
});
test('duplicate follow-up request and a different author cannot create a task', async () => {
  store.claimTask.mockResolvedValue(null);
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('message', expect.stringContaining('already attempted'));
  store.readDecision.mockResolvedValue({ ...concern, authorAccountId: 'other-user' });
  expect(await handler.createConcernTask({ context, payload: followup })).toBeNull();
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(0);
});
