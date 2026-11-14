jest.mock('@forge/kvs', () => ({ kvs: { get: jest.fn() } }));
jest.mock('@forge/resolver', () => ({ __esModule: true, default: class {
  definitions = {};
  define(name, fn) { this.definitions[name] = fn; }
  getDefinitions() { return this.definitions; }
} }));
jest.mock('@forge/api', () => ({ __esModule: true, default: { asUser: jest.fn() },
  route: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.mock('../decisionStore', () => ({ commitDecision: jest.fn(), getPairState: jest.fn(), queryRecords: jest.fn(), pairConfirmed: jest.fn(), PAIR_ENTITY: "pair-state", DECISION_ENTITY: "decision",
  readDecision: jest.fn(), claimTask: jest.fn(), saveTaskMetadata: jest.fn(), saveTaskLinked: jest.fn() }));

const api = require('@forge/api').default;
const { kvs } = require('@forge/kvs');
const store = require('../decisionStore');
const { handler } = require('../index');
const requestJira = jest.fn();
const context = { accountId: 'server-account', extension: { issue: { id: '10001' } } };
const nc = { schemaVersion: 2, recordType: 'NC', partOriginal: 'P-4471-A', failureMode: 'FM-01', detectedDate: '2026-10-31' };
const capa = { ...nc, recordType: 'CAPA', closedDate: '2026-10-01', effectivenessEvidenceUrl: 'https://example.com/evidence' };
const project = { id: '123', key: 'QL' };
const issue = (id, capture = capa) => ({ id, key: `QL-${id}`, self: `https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/${id}`, properties: { qualityloop: capture },
  fields: { summary: `Summary ${id}`, project, status: { name: 'Done' } } });
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: jest.fn(async () => value) });
const payload = { capaId: '20002', expectedVersion: 0, type: 'CONFIRM', reason: 'Review evidence', evidenceLinks: [] };
const decisionId = '20002:10001:1793400000000-12345678-1234-1234-1234-123456789abc';
const concern = { issueId: '10001', capaId: '20002', type: 'CONCERN', reason: 'Review evidence',
  authorAccountId: 'server-account', evidenceLinks: [], createdAt: '2026-10-31T12:00:00.000Z' };
const { followupConfirmation } = require('../../lib/decisions');
const { followupDescription, descriptionPreview } = require('../../lib/followup');
const confirmation = (assignee, options = {}) => followupConfirmation('QL', 'QL-20002', assignee, { ncKey: 'QL-10001', typeName: 'Task',
  description: descriptionPreview(followupDescription(concern, issue('10001', nc), issue('20002'), 'https://example.atlassian.net')), ...options });
const followup = { capaId: '20002', decisionId, confirmation: confirmation() };
const markerToken = 'a0b1c2d3e4f56789a0b1c2d3e4f56789';
const opaqueMarker = { schemaVersion: 2, token: markerToken };
let edit;
let create;
let hidden;
let captured;
let current;
let searchIds;
let createStatus;
let linkStatus;
let createdProperties;
let createdFields;
let createdLinks;
beforeEach(() => {
  jest.clearAllMocks();
  kvs.get.mockReset().mockResolvedValue(undefined);
  api.asUser.mockReturnValue({ requestJira });
  edit = true; create = true; hidden = new Set(); captured = capa; current = nc; searchIds = ['20002']; createStatus = 201; linkStatus = 201;
  createdProperties = {};
  createdFields = {}; createdLinks = [];
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/serverInfo') return response(200, { baseUrl: 'https://example.atlassian.net' });
    if (path.includes('mypermissions')) return response(200, { permissions: {
      EDIT_ISSUES: { havePermission: edit }, CREATE_ISSUES: { havePermission: create } } });
    if (path === '/rest/api/3/issue/10001/properties/qualityloop') return response(200, { value: current });
    if (path === '/rest/api/3/search/jql') return response(200, { issues: searchIds.map((id) => issue(id, captured)), isLast: true });
    if (path.startsWith('/rest/api/3/user?')) return response(200, { displayName: 'Engineer' });
    if (path.startsWith('/rest/api/3/issue/createmeta/')) return response(200, { issueTypes: [{ id: '987', name: 'Task', subtask: false }], total: 1 });
    if (path === '/rest/api/3/issueLinkType') return response(200, { issueLinkTypes: [{ id: 'relates-id', name: 'Relates', inward: 'relates to', outward: 'relates to' }] });
    if (path === '/rest/api/3/issue' && options.method === 'POST') {
      if (createStatus === 201) createdProperties = Object.fromEntries(JSON.parse(options.body).properties.map(({ key, value }) => [key, value]));
      if (createStatus === 201) createdFields = JSON.parse(options.body).fields;
      return response(createStatus, { id: '30003', key: 'QL-30003' });
    }
    if (path === '/rest/api/3/issueLink') {
      if (linkStatus === 201) createdLinks.push({ type: { name: 'Relates' }, inwardIssue: JSON.parse(options.body).inwardIssue });
      return response(linkStatus);
    }
    const id = path.match(/^\/rest\/api\/3\/issue\/([^?/]+)/)?.[1]?.replace(/^QL-/, '');
    if (hidden.has(id)) return response(403, { secret: 'hidden' });
    if (id) {
      if (path.endsWith('/properties/qualityloop-followup') && options?.method === 'PUT') {
        createdProperties['qualityloop-followup'] = JSON.parse(options.body); return response(204);
      }
      if (id === '30003' && options?.method === 'PUT') { createdFields.description = JSON.parse(options.body).fields.description; return response(204); }
      const data = issue(id, id === '10001' ? current : captured);
      if (id === '30003') { data.properties = { ...data.properties, ...createdProperties };
        data.fields = { ...data.fields, ...createdFields, assignee: null, issuelinks: createdLinks }; }
      return response(200, data);
    }
    throw new Error(`Unexpected API path ${path}`);
  });
  store.getPairState.mockResolvedValue({ version: 0, state: 'NONE' });
  store.commitDecision.mockResolvedValue({ success: true });
  store.queryRecords.mockResolvedValue({ records: [], incomplete: false });
  store.pairConfirmed.mockImplementation(async (state) => state.confirmed === true);
  store.readDecision.mockResolvedValue(concern);
  store.claimTask.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: '2026-10-31T12:01:00.000Z',
    taskMarkerVersion: 2, taskMarkerToken: markerToken });
  store.saveTaskMetadata.mockResolvedValue();
  store.saveTaskLinked.mockResolvedValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('panel loads EDIT_ISSUES in current issue context and non-editors receive read-only access', async () => {
  edit = false;
  expect(await handler.getPanelAccess({ context })).toEqual({ canEdit: false, revisionPreset: 'LETTERS' });
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

test('decision validation honours the NC project look-back and scope using fresh Jira reads', async () => {
  captured = { ...capa, closedDate: new Date(Date.parse(nc.detectedDate) - 400 * 86400000).toISOString().slice(0, 10) };
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  expect(store.commitDecision).not.toHaveBeenCalled();
  kvs.get.mockResolvedValue({ version: 1, scope: 'PROJECT', lookbackDays: 730, projectIds: [] });
  expect(await handler.recordDecision({ context, payload })).toEqual({ success: true });
  expect(kvs.get).toHaveBeenCalledWith('settings:123');
  store.commitDecision.mockClear();
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    const response = await original(path, options);
    if (path.startsWith('/rest/api/3/issue/20002?')) {
      const body = await response.json();
      return { ...response, json: async () => ({ ...body, fields: { ...body.fields, project: { id: '456', key: 'OTHER' } } }) };
    }
    return response;
  });
  expect(await handler.recordDecision({ context, payload })).toHaveProperty('error');
  expect(store.commitDecision).not.toHaveBeenCalled();
});

test.each([
  ['http://example.com/report', 'Use an https:// link.'],
  ['https://user:pass@example.com/x', 'Remove the user name and password from the link.'],
  [' https://example.com/report', 'Remove spaces before or after the link.'],
  ['https://example.com/report ', 'Remove spaces before or after the link.'],
  ['javascript:alert(1)', 'Use an https:// link.'],
  ['https:///report', 'Enter a full https:// link.'],
  ['https://example.com/a\nb', 'Enter a full https:// link.'],
])(
  'direct recordDecision returns the specific reason for %j without committing it', async (url, reason) => {
    expect(await handler.recordDecision({ context, payload: { ...payload, evidenceLinks: [url] } }))
      .toEqual({ fieldErrors: { evidenceLinks: reason } });
    expect(store.commitDecision).not.toHaveBeenCalled();
  },
);
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
  const proposal = await handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } });
  expect(proposal).toEqual({ confirmation: confirmation() });
  expect(proposal.confirmation).not.toContain('If Jira rejects');
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
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('message', 'Recorded. Created QL-30003 and linked it to QL-20002 and QL-10001; unassigned.');
  const post = requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issue');
  expect(JSON.parse(post[1].body)).toEqual({ fields: { project: { id: '123' }, issuetype: { id: '987' }, summary: 'Effectiveness re-review: QL-20002', assignee: null,
    description: followupDescription(concern, issue('10001', nc), issue('20002'), 'https://example.atlassian.net') },
    properties: [{ key: 'qualityloop-followup', value: opaqueMarker }] });
  expect(store.saveTaskMetadata).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskKey: 'QL-30003', reason: concern.reason }));
  const link = requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issueLink');
  expect(JSON.parse(link[1].body)).toEqual({ type: { id: 'relates-id' }, outwardIssue: { id: '30003' }, inwardIssue: { id: '20002' } });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')
    .map(([, options]) => JSON.parse(options.body).inwardIssue.id)).toEqual(['20002', '10001']);
});

test.each([null, 'https://api.atlassian.com', 'http://example.atlassian.net', 'denied', 'offline'])(
  'unavailable or invalid serverInfo baseUrl (%s) creates a plain-text NC reference', async (baseUrl) => {
    const original = requestJira.getMockImplementation();
    requestJira.mockImplementation(async (path, options) => {
      if (path === '/rest/api/3/serverInfo') {
        if (baseUrl === 'offline') throw new Error('Unavailable');
        return response(baseUrl === 'denied' ? 403 : 200, { baseUrl });
      }
      return original(path, options);
    });
    const proposal = await handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } });
    expect(proposal.confirmation).toContain('NC: QL-10001: Summary 10001\n');
    const result = await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } });
    expect(result.message).toContain('Created QL-30003');
    expect(createdFields.description.content[1].content).toEqual([
      { type: 'text', text: 'NC: ' }, { type: 'text', text: 'QL-10001: Summary 10001' },
    ]);
    expect(JSON.stringify(createdFields.description)).not.toContain('api.atlassian.com');
    expect(api.asUser).toHaveBeenCalledTimes(requestJira.mock.calls.length);
  });

test('site browse URL comes from serverInfo, ignoring gateway self and unverified context fields', async () => {
  const suppliedContext = { ...context, siteUrl: 'https://other.example', extension: { ...context.extension, location: 'https://other.example/browse/QL-10001' } };
  await handler.createConcernTask({ context: suppliedContext, payload: followup });
  expect(createdFields.description.content[1].content[1].marks).toEqual([
    { type: 'link', attrs: { href: 'https://example.atlassian.net/browse/QL-10001' } },
  ]);
  expect(JSON.stringify(createdFields.description)).not.toMatch(/api\.atlassian\.com|other\.example/);
});

test('a changed site URL invalidates the displayed confirmation before claiming or creating', async () => {
  const proposal = await handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } });
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation((path, options) => path === '/rest/api/3/serverInfo'
    ? response(200, { baseUrl: 'https://renamed.atlassian.net' }) : original(path, options));
  expect(await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } })).toHaveProperty('error');
  expect(store.claimTask).not.toHaveBeenCalled();
  expect(requestJira.mock.calls.some(([path]) => path === '/rest/api/3/issue')).toBe(false);
});
test('task creation or linking errors preserve the concern and expose the separate error', async () => {
  createStatus = 400;
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('error', expect.stringMatching(/Recorded.*HTTP 400/));
  expect(store.commitDecision).not.toHaveBeenCalled();
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  createStatus = 201; linkStatus = 403;
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('message', expect.stringContaining('with limits'));
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

function withAssignee(owner, { rejected = false, changedOwner = false } = {}) {
  const original = requestJira.getMockImplementation();
  let reads = 0;
  let attempts = 0;
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/issue') {
      attempts++;
      if (rejected && attempts === 1) return response(400, { errors: { assignee: 'Not assignable' } });
    }
    const result = await original(path, options);
    if (path.startsWith('/rest/api/3/issue/20002?') || path.startsWith('/rest/api/3/issue/30003?') || path.startsWith('/rest/api/3/issue/QL-30003?')) {
      const data = await result.json();
      const assignee = path.includes('/20002?') ? (++reads > 1 && changedOwner ? { accountId: 'new-owner', displayName: 'New owner' } : owner)
        : rejected ? null : owner;
      return response(200, { ...data, fields: { ...data.fields, assignee } });
    }
    return result;
  });
}

test.each(['CAPA Owner', undefined, null, '', '   '])('confirmation and success show the CAPA owner name (%s) without its account ID', async (displayName) => {
  withAssignee({ accountId: 'private-owner-id', displayName });
  const label = displayName?.trim() || "the CAPA's current assignee";
  const proposal = await handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } });
  expect(proposal.confirmation).toBe(confirmation({ accountId: 'private-owner-id', displayName }));
  expect(JSON.stringify(proposal)).not.toContain('private-owner-id');
  const result = await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } });
  expect(result.message).toContain(`assigned to ${label}.`);
  expect(JSON.stringify(result)).not.toContain('private-owner-id');
  expect(JSON.parse(requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issue')[1].body).fields.assignee).toEqual({ accountId: 'private-owner-id' });
});

test('definitive assignee rejection retries unassigned under the same durable claim', async () => {
  const owner = { accountId: 'owner', displayName: 'CAPA Owner' };
  withAssignee(owner, { rejected: true });
  const result = await handler.createConcernTask({ context, payload: { ...followup, confirmation: confirmation(owner) } });
  expect(result.message).toContain('; unassigned.');
  const attempts = requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue');
  expect(attempts.map(([, options]) => JSON.parse(options.body).fields.assignee)).toEqual([{ accountId: 'owner' }, null]);
  expect(store.claimTask).toHaveBeenCalledTimes(1);
});

test.each([403, 429, 500, 503])('assignment creation HTTP %i never causes an automatic retry', async (status) => {
  const owner = { accountId: 'owner', displayName: 'CAPA Owner' };
  withAssignee(owner); createStatus = status;
  await handler.createConcernTask({ context, payload: { ...followup, confirmation: confirmation(owner) } });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
});

test.each(['CAPA Owner', 'New owner'])('a changed owner invalidates confirmation before claim or creation, including matching names (%s)', async (displayName) => {
  const owner = { accountId: 'owner', displayName };
  withAssignee(owner, { changedOwner: true });
  expect(await handler.createConcernTask({ context, payload: { ...followup, confirmation: confirmation(owner) } }))
    .toHaveProperty('error', expect.stringContaining('assignee changed'));
  expect(store.claimTask).not.toHaveBeenCalled();
});

const claimedAt = '2026-10-31T12:01:00.000Z';
const recoveryTask = (id = '30003', patch = {}) => ({ ...issue(id), fields: { project, summary: 'Effectiveness re-review: QL-20002',
  created: '2026-10-31T12:02:00.000Z', ...patch } });
function recoveryScenario(rows, { incomplete = false, direct = rows } = {}) {
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt });
  store.saveTaskMetadata.mockResolvedValue(true);
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/search/jql' && JSON.parse(options.body).jql.includes('summary ~')) {
      return response(200, { issues: rows, isLast: !incomplete });
    }
    const id = path.match(/issue\/(\d+)\?/)?.[1];
    if (id && !hidden.has(id) && direct.some((task) => task.id === id)) return response(200, direct.find((task) => task.id === id));
    return original(path, options);
  });
}

test('unconfirmed claims show recovery without exposing claim IDs', async () => {
  store.queryRecords.mockImplementation(async (entity) => ({ records: entity === 'decision'
    ? [{ ...concern, id: decisionId, taskClaimId: 'claim', taskClaimedAt: claimedAt }] : [], incomplete: false }));
  const result = await handler.loadEvidence({ context });
  expect(result.pairs['20002'].history[0]).toMatchObject({ followupUnconfirmed: true });
  expect(JSON.stringify(result)).not.toContain('taskClaimId');
});

test('recovery finds one visible task and stores its key only after explicit confirmation', async () => {
  recoveryScenario([recoveryTask()]);
  const recoveryPayload = { capaId: '20002', decisionId };
  const proposal = await handler.checkConcernTask({ context, payload: recoveryPayload });
  expect(proposal).toMatchObject({ task: { id: '30003', key: 'QL-30003' } });
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  expect(await handler.confirmConcernTask({ context, payload: { ...recoveryPayload, taskId: proposal.task.id, confirmation: 'yes' } }))
    .toHaveProperty('error');
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  expect(await handler.confirmConcernTask({ context, payload: { ...recoveryPayload, taskId: proposal.task.id, confirmation: proposal.confirmation } }))
    .toMatchObject({ taskKey: 'QL-30003' });
  expect(store.saveTaskMetadata).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskClaimId: 'claim', taskKey: 'QL-30003' }));
  expect(store.claimTask).not.toHaveBeenCalled();
  expect(requestJira.mock.calls.filter(([path, options]) => options?.method === 'POST' && path !== '/rest/api/3/search/jql')).toEqual([]);
});

test.each([
  [[], 'No visible matching task'],
  [[recoveryTask(), recoveryTask('30004')], 'More than one visible matching task'],
  [[recoveryTask('30003', { created: claimedAt })], 'No visible matching task'],
  [[recoveryTask('30003', { summary: 'Effectiveness re-review: QL-20002 extra' })], 'No visible matching task'],
])('recovery does not record ambiguous or invalid results', async (rows, message) => {
  recoveryScenario(rows);
  expect(await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } })).toHaveProperty('message', expect.stringContaining(message));
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  expect(store.claimTask).not.toHaveBeenCalled();
});

test('a subsequently hidden task contributes neither a key nor a count', async () => {
  recoveryScenario([recoveryTask()]); hidden.add('30003');
  const result = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
  expect(result.message).toContain('No visible matching task');
  expect(JSON.stringify(result)).not.toMatch(/QL-30003|SECRET/);
});

test('incomplete recovery never claims a unique result', async () => {
  recoveryScenario([recoveryTask()], { incomplete: true });
  const result = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
  expect(result.message).toContain('incomplete');
  expect(result.task).toBeUndefined();
});

test('old claims without a timestamp explain the limitation and never create or guess', async () => {
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'old-claim' });
  expect(await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } }))
    .toHaveProperty('message', expect.stringContaining('claim time was not recorded'));
  expect(requestJira.mock.calls.some(([path]) => path === '/rest/api/3/search/jql')).toBe(false);
});

test('recovery confirms uniqueness again and refuses a task introduced after the dialog', async () => {
  const rows = [recoveryTask()]; recoveryScenario(rows);
  const proposal = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
  rows.push(recoveryTask('30004'));
  const result = await handler.confirmConcernTask({ context, payload: { capaId: '20002', decisionId, taskId: '30003', confirmation: proposal.confirmation } });
  expect(result.message).toContain('More than one');
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
});

test.each([403, 404])('recovery denies a payload task HTTP %i before reading decision storage', async (status) => {
  requestJira.mockResolvedValue(response(status, {}));
  expect(await handler.confirmConcernTask({ context, payload: { capaId: '20002', decisionId, taskId: '30003', confirmation: 'yes' } })).toBeNull();
  expect(store.readDecision).not.toHaveBeenCalled();
});

test('per-CAPA decision loads run concurrently with a maximum of five', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(20002 + i));
  store.queryRecords.mockImplementation(async (entity, index) => ({ records: entity === 'pair-state' && index === 'by-issue'
    ? ids.map((capaId) => ({ capaId, issueId: '10001' })) : [], incomplete: false }));
  let active = 0, peak = 0;
  store.getPairState.mockImplementation(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return { version: 0, state: 'NONE' };
  });
  const result = await handler.loadEvidence({ context });
  expect(Object.keys(result.pairs)).toHaveLength(12);
  expect(peak).toBe(5);
  const reads = requestJira.mock.calls.filter(([path]) => path.startsWith('/rest/api/3/issue/20002?'));
  expect(reads).toHaveLength(1); // match verification reused by decision loading
});

test('parallel CAPAs share an in-flight referenced NC authorization read', async () => {
  store.queryRecords.mockImplementation(async (entity, index, partition) => ({ records: entity !== 'pair-state' ? []
    : index === 'by-issue' ? ['20002', '20003', '20004'].map((capaId) => ({ capaId, issueId: '10001' }))
      : [{ capaId: partition, issueId: '10009' }], incomplete: false }));
  store.getPairState.mockResolvedValue({ version: 1, state: 'CONFIRMED', confirmed: true });
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, ...rest) => {
    if (path.startsWith('/rest/api/3/issue/10009?')) await new Promise((resolve) => setImmediate(resolve));
    return original(path, ...rest);
  });
  const result = await handler.loadEvidence({ context });
  expect(Object.values(result.pairs).map((pair) => pair.confirmedCount)).toEqual([1, 1, 1]);
  expect(requestJira.mock.calls.filter(([path]) => path.startsWith('/rest/api/3/issue/10009?'))).toHaveLength(1);
});

test.each(['transport', 'generic400'])('an uncertain or unrelated assignment failure (%s) never retries creation', async (failure) => {
  const owner = { accountId: 'owner', displayName: 'CAPA Owner' };
  withAssignee(owner);
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/issue') {
      if (failure === 'transport') throw new Error('Connection interrupted');
      return response(400, { errors: { customfield_1: 'Required' } });
    }
    return original(path, options);
  });
  const result = await handler.createConcernTask({ context, payload: { ...followup, confirmation: confirmation(owner) } });
  expect(result.error).toBeDefined();
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
});

test.each(['by-capa', 'history', 'by-issue'])('budget exhausted in optional %s work retains every displayed state/version', async (stage) => {
  searchIds = Array.from({ length: 6 }, (_, i) => String(20002 + i));
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  store.getPairState.mockResolvedValue({ version: 7, state: 'CONFIRMED', confirmed: true });
  store.queryRecords.mockImplementation(async (entity, index, partition, { budget }) => {
    if ((stage === 'history' && entity === 'decision') || index === stage) {
      // All six essential states must load before the first optional query.
      expect(store.getPairState).toHaveBeenCalledTimes(6);
      clock = 15001;
      budget.check();
    }
    return { records: [], incomplete: false };
  });
  const result = await handler.loadEvidence({ context });
  expect(result).toMatchObject({ incomplete: true, decisionsIncomplete: true });
  expect(Object.keys(result.pairs)).toHaveLength(6);
  for (const data of Object.values(result.pairs)) {
    expect(data).toMatchObject({ pairState: { version: 7, state: 'CONFIRMED' }, pairStateIncomplete: false,
      confirmedCount: null, confirmedCountUnavailable: true });
  }
});

test('a hanging essential pair-state read stays unavailable while completed cards retain their state', async () => {
  jest.useFakeTimers();
  try {
    searchIds = Array.from({ length: 6 }, (_, i) => String(20002 + i));
    store.getPairState.mockImplementation(async (capaId) => capaId === '20007' ? new Promise(() => {}) : { version: 3, state: 'CONFIRMED' });
    const pending = handler.loadEvidence({ context });
    await jest.advanceTimersByTimeAsync(15000);
    const result = await pending;
    expect(result).toMatchObject({ incomplete: true, decisionsIncomplete: true });
    expect(Object.keys(result.pairs)).toHaveLength(5);
    expect(result.pairs['20007']).toBeUndefined();
    expect(result.pairs['20002'].pairState.version).toBe(3);
    expect(store.queryRecords).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test('creation includes the durable opaque marker, verifies it without another write, links, then records link completion', async () => {
  const result = await handler.createConcernTask({ context, payload: followup });
  expect(result.message).toContain('Created QL-30003 and linked');
  const createIndex = requestJira.mock.calls.findIndex(([path]) => path === '/rest/api/3/issue');
  expect(JSON.parse(requestJira.mock.calls[createIndex][1].body).properties).toEqual([{ key: 'qualityloop-followup', value: opaqueMarker }]);
  expect(requestJira.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  const verifyIndex = requestJira.mock.calls.findIndex(([path]) => path.startsWith('/rest/api/3/issue/30003?') && path.includes('properties=qualityloop-followup'));
  expect(verifyIndex).toBeGreaterThan(createIndex);
  const linkIndex = requestJira.mock.calls.findIndex(([path]) => path === '/rest/api/3/issueLink');
  expect(store.claimTask.mock.invocationCallOrder[0]).toBeLessThan(requestJira.mock.invocationCallOrder[createIndex]);
  expect(store.saveTaskMetadata.mock.invocationCallOrder[0]).toBeLessThan(requestJira.mock.invocationCallOrder[verifyIndex]);
  expect(requestJira.mock.invocationCallOrder[verifyIndex]).toBeLessThan(requestJira.mock.invocationCallOrder[linkIndex]);
  const capaCompletion = store.saveTaskLinked.mock.calls.findIndex(([, , target]) => target === 'capa');
  expect(requestJira.mock.invocationCallOrder[linkIndex]).toBeLessThan(store.saveTaskLinked.mock.invocationCallOrder[capaCompletion]);
  expect(store.saveTaskLinked).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskKey: 'QL-30003', taskClaimId: 'claim' }), 'capa');
  expect(store.saveTaskLinked).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskKey: 'QL-30003' }), 'nc');
});

test('failed link creation retains the saved key and exposes the task as needing repair in history', async () => {
  linkStatus = 500;
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('message', expect.stringContaining('with limits'));
  const saved = store.saveTaskMetadata.mock.calls[0][1];
  expect(saved.taskKey).toBe('QL-30003');
  expect(saved.taskLinkedAt).toBeUndefined();
  expect(store.saveTaskLinked.mock.calls.map(([, , target]) => target)).toEqual(['description']);
  store.queryRecords.mockImplementation(async (entity) => ({ records: entity === 'decision' ? [{ id: decisionId, ...saved }] : [], incomplete: false }));
  const view = await handler.loadEvidence({ context });
  expect(view.pairs['20002'].history[0]).toMatchObject({ taskKey: 'QL-30003', taskLinked: false });
});

const markedRecoveryTask = (markerPatch = {}) => ({ ...recoveryTask(), properties: { 'qualityloop-followup': {
  schemaVersion: 1, decisionId, capaId: '20002', ncId: '10001', claimedAt, ...markerPatch } } });

test('new recovery accepts only the freshly read correlation marker, then requires explicit confirmation', async () => {
  recoveryScenario([recoveryTask()], { direct: [markedRecoveryTask()] });
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt, taskMarkerVersion: 1 });
  const proposal = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
  expect(proposal.task).toEqual({ id: '30003', key: 'QL-30003' });
  expect(proposal.confirmation).not.toContain('no QualityLoop marker');
  expect(requestJira.mock.calls.some(([path]) => path.includes('properties=qualityloop-followup'))).toBe(true);
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
});

test.each([null, { decisionId: 'other' }, { capaId: 'other' }, { ncId: 'other' }, { claimedAt: 'other' }, { schemaVersion: 2 }])(
  'same-summary task with missing or conflicting marker cannot recover a new claim (%j)', async (patch) => {
    const task = patch === null ? recoveryTask() : markedRecoveryTask(patch);
    recoveryScenario([markedRecoveryTask()], { direct: [task] });
    store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt, taskMarkerVersion: 1 });
    const result = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
    expect(result.task).toBeUndefined();
    expect(result.message).toContain('No visible matching task');
    expect(store.saveTaskMetadata).not.toHaveBeenCalled();
    expect(store.claimTask).not.toHaveBeenCalled();
    expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(0);
  });

test('legacy unmarked recovery has the mandatory warning and rechecks it on confirmation', async () => {
  recoveryScenario([recoveryTask()]);
  const proposal = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
  expect(proposal.confirmation).toContain('This task has no QualityLoop marker; confirm only if you know it is the follow-up task.');
  const { recoveryConfirmation } = require('../../lib/followup');
  expect(await handler.confirmConcernTask({ context, payload: { capaId: '20002', decisionId, taskId: '30003',
    confirmation: recoveryConfirmation('QL-30003', 'QL-20002') } })).toHaveProperty('error');
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
});

test('recovery rejects a marker changed after the proposal and never creates a replacement', async () => {
  const task = markedRecoveryTask(); recoveryScenario([task]);
  const proposal = await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } });
  task.properties['qualityloop-followup'].decisionId = 'other';
  expect(await handler.confirmConcernTask({ context, payload: { capaId: '20002', decisionId, taskId: '30003', confirmation: proposal.confirmation } }))
    .toHaveProperty('message', expect.stringContaining('No visible matching task'));
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  expect(store.claimTask).not.toHaveBeenCalled();
});

function repairScenario(links = []) {
  const task = markedRecoveryTask();
  task.fields.issuelinks = [...links, { type: { name: 'Relates' }, inwardIssue: { id: '10001', key: 'QL-10001' } }];
  task.fields.description = followupDescription(concern, issue('10001', nc), issue('20002'), 'https://example.atlassian.net');
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt, taskMarkerVersion: 1, taskKey: task.key });
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    if (path.startsWith('/rest/api/3/issue/QL-30003?')) return hidden.has('30003') ? response(403, {}) : response(200, task);
    if (path === '/rest/api/3/issue/30003' && options?.method === 'PUT') { task.fields.description = JSON.parse(options.body).fields.description; return response(204); }
    if (path.endsWith('/properties/qualityloop-followup') && options?.method === 'PUT') { task.properties['qualityloop-followup'] = JSON.parse(options.body); return response(204); }
    if (path === '/rest/api/3/issueLink' && linkStatus === 201) {
      task.fields.issuelinks.push({ type: { name: 'Relates' }, inwardIssue: JSON.parse(options.body).inwardIssue });
    }
    return original(path, options);
  });
  return task;
}

test.each([true, false])('Verify repairs an empty description with site link available=%s', async (available) => {
  const task = repairScenario();
  task.fields.description = null;
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation((path, options) => path === '/rest/api/3/serverInfo'
    ? response(available ? 200 : 404, { baseUrl: 'https://example.atlassian.net' }) : original(path, options));
  const payload = { capaId: '20002', decisionId };
  const proposal = await handler.prepareRepairLink({ context, payload });
  expect(proposal.confirmation.includes('https://example.atlassian.net/browse/QL-10001')).toBe(available);
  const result = await handler.repairConcernLink({ context, payload: { ...payload, confirmation: proposal.confirmation } });
  expect(result.message).toMatch(/verified/);
  const reference = task.fields.description.content[1].content[1];
  expect(reference.text).toBe('QL-10001: Summary 10001');
  expect(reference.marks).toEqual(available ? [{ type: 'link', attrs: { href: 'https://example.atlassian.net/browse/QL-10001' } }] : undefined);
  expect(JSON.stringify(task.fields.description)).not.toContain('api.atlassian.com');
});
const repairPayload = { capaId: '20002', decisionId };

test.each([true, false])('legacy task verification with existing link=%s checks before creating and stays idempotent', async (existing) => {
  const task = repairScenario(existing ? [{ type: { name: 'Relates' }, outwardIssue: { id: '20002' } }] : []);
  delete task.properties['qualityloop-followup'];
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'legacy-claim', taskClaimedAt: claimedAt, taskKey: task.key });
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  expect(proposal.confirmation).toContain('Check the Relates link to CAPA QL-20002; add it only if missing.\nCheck the Relates link to NC QL-10001; add it only if missing.');
  expect(proposal.confirmation).toContain('This task has no QualityLoop marker; confirm only if you know it is the follow-up task.');
  expect(requestJira.mock.calls.some(([, options]) => ['POST', 'PUT'].includes(options?.method))).toBe(false);
  const confirmed = { ...repairPayload, confirmation: proposal.confirmation };
  await handler.repairConcernLink({ context, payload: confirmed });
  await handler.repairConcernLink({ context, payload: confirmed });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(existing ? 0 : 1);
  expect(requestJira.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  expect(store.saveTaskLinked).toHaveBeenCalledTimes(6);
});
test.each(['inwardIssue', 'outwardIssue'])('repair of an existing %s Relates link writes no link and records completion', async (direction) => {
  repairScenario([{ type: { name: 'Relates' }, [direction]: { id: '20002' } }]);
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  expect(proposal.confirmation).toContain('Check the Relates link to CAPA QL-20002; add it only if missing.\nCheck the Relates link to NC QL-10001; add it only if missing.');
  expect(store.saveTaskLinked).not.toHaveBeenCalled();
  expect(await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: proposal.confirmation } }))
    .toHaveProperty('message', expect.stringContaining('verified and recorded'));
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(0);
  expect(store.saveTaskLinked).toHaveBeenCalledTimes(3);
});
test('repair creates exactly one missing Relates link across repeated confirmed invocations', async () => {
  repairScenario([{ type: { name: 'Blocks' }, inwardIssue: { id: '20002' } }]);
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  const confirmed = { ...repairPayload, confirmation: proposal.confirmation };
  await handler.repairConcernLink({ context, payload: confirmed });
  await handler.repairConcernLink({ context, payload: confirmed });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(1);
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(0);
  expect(store.claimTask).not.toHaveBeenCalled();
});
test('repair requires exact confirmation and fresh task/CAPA/current-issue access', async () => {
  repairScenario();
  expect(await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: 'yes' } })).toHaveProperty('error');
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  hidden.add('30003');
  expect(await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: proposal.confirmation } })).toBeNull();
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(0);
  expect(store.saveTaskLinked).not.toHaveBeenCalled();
});
test('repair can finish a failed marker write only when that write is listed and confirmed', async () => {
  const task = repairScenario(); delete task.properties['qualityloop-followup'];
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  expect(proposal.confirmation).toContain('Set the qualityloop-followup marker property on QL-30003 for this decision.');
  await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: proposal.confirmation } });
  expect(requestJira.mock.calls.filter(([path, options]) => path.endsWith('/properties/qualityloop-followup') && options.method === 'PUT')).toHaveLength(1);
});

test('fallback marker failure after Jira ignores create properties preserves the key, skips linking and cannot create a replacement', async () => {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    if (path.endsWith('/properties/qualityloop-followup')) return response(500, {});
    const result = await original(path, options);
    if (path === '/rest/api/3/issue') createdProperties = {};
    return result;
  });
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('error');
  const saved = store.saveTaskMetadata.mock.calls[0][1];
  expect(saved).toMatchObject({ taskKey: 'QL-30003', taskMarkerVersion: 2, taskMarkerToken: markerToken });
  expect(store.saveTaskLinked).not.toHaveBeenCalled();
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(0);
  store.readDecision.mockResolvedValue(saved);
  await handler.createConcernTask({ context, payload: followup });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
});

test('wrong-marker and unmarked candidates cannot make one correctly marked new recovery ambiguous', async () => {
  const rows = [markedRecoveryTask(), { ...markedRecoveryTask({ decisionId: 'other' }), id: '30004', key: 'QL-30004' }, recoveryTask('30005')];
  recoveryScenario(rows);
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt, taskMarkerVersion: 1 });
  expect(await handler.checkConcernTask({ context, payload: { capaId: '20002', decisionId } })).toHaveProperty('task', { id: '30003', key: 'QL-30003' });
});

test('recovery finds the create-time token after a lost create response with no taskKey stored', async () => {
  let durable = concern;
  const claimed = await store.claimTask.getMockImplementation()();
  store.claimTask.mockImplementation(async () => { durable = claimed; return claimed; });
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    if (path === '/rest/api/3/issue') {
      expect(durable.taskMarkerToken).toBe(markerToken);
      await original(path, options); // Jira commits the task and its property.
      throw new Error('Create response lost');
    }
    return original(path, options);
  });
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('error');
  expect(durable.taskKey).toBeUndefined();
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  expect(createdProperties).toEqual({ 'qualityloop-followup': opaqueMarker });
  const task = { ...recoveryTask(), properties: createdProperties };
  recoveryScenario([task]);
  store.readDecision.mockImplementation(async () => durable);
  const proposal = await handler.checkConcernTask({ context, payload: repairPayload });
  expect(proposal.task).toEqual({ id: '30003', key: 'QL-30003' });
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
  expect(await handler.confirmConcernTask({ context, payload: { ...repairPayload,
    taskId: proposal.task.id, confirmation: proposal.confirmation } })).toHaveProperty('taskKey', 'QL-30003');
  expect(store.saveTaskMetadata).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskMarkerToken: markerToken, taskKey: 'QL-30003' }));
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
  expect(store.claimTask).toHaveBeenCalledTimes(1);
});

test.each([null, { schemaVersion: 2, token: 'f'.repeat(32) }, { schemaVersion: 2 },
  { schemaVersion: 1, decisionId, capaId: '20002', ncId: '10001', claimedAt }])(
  'v2 recovery rejects a same-summary task without the exact stored token: %j', async (marker) => {
    const task = { ...recoveryTask(), properties: marker ? { 'qualityloop-followup': marker } : {} };
    recoveryScenario([task]);
    store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt,
      taskMarkerVersion: 2, taskMarkerToken: markerToken });
    expect(await handler.checkConcernTask({ context, payload: repairPayload }))
      .toHaveProperty('message', expect.stringContaining('No visible matching task'));
    expect(store.saveTaskMetadata).not.toHaveBeenCalled();
    expect(store.claimTask).not.toHaveBeenCalled();
  });

test('v2 recovery rechecks the token before recording the confirmed task', async () => {
  const task = { ...recoveryTask(), properties: { 'qualityloop-followup': { ...opaqueMarker } } };
  recoveryScenario([task]);
  store.readDecision.mockResolvedValue({ ...concern, taskClaimId: 'claim', taskClaimedAt: claimedAt,
    taskMarkerVersion: 2, taskMarkerToken: markerToken });
  const proposal = await handler.checkConcernTask({ context, payload: repairPayload });
  task.properties['qualityloop-followup'].token = 'f'.repeat(32);
  expect(await handler.confirmConcernTask({ context, payload: { ...repairPayload, taskId: '30003', confirmation: proposal.confirmation } }))
    .toHaveProperty('message', expect.stringContaining('No visible matching task'));
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
});

test('a verified absence after create permits the fallback opaque marker write before linking', async () => {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    const result = await original(path, options);
    if (path === '/rest/api/3/issue') createdProperties = {};
    return result;
  });
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('message', expect.stringContaining('Created QL-30003'));
  const verifyIndex = requestJira.mock.calls.findIndex(([path]) => path.startsWith('/rest/api/3/issue/30003?'));
  const markerIndex = requestJira.mock.calls.findIndex(([path]) => path.endsWith('/properties/qualityloop-followup'));
  const linkIndex = requestJira.mock.calls.findIndex(([path]) => path === '/rest/api/3/issueLink');
  expect(verifyIndex).toBeLessThan(markerIndex);
  expect(markerIndex).toBeLessThan(linkIndex);
  expect(JSON.parse(requestJira.mock.calls[markerIndex][1].body)).toEqual(opaqueMarker);
});

test('a conflicting create-time property is never overwritten or linked', async () => {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    const result = await original(path, options);
    if (path === '/rest/api/3/issue') createdProperties = { 'qualityloop-followup': { schemaVersion: 2, token: 'f'.repeat(32) } };
    return result;
  });
  expect(await handler.createConcernTask({ context, payload: followup })).toHaveProperty('error', expect.stringContaining('marker could not be verified'));
  expect(requestJira.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  expect(requestJira.mock.calls.some(([path]) => path === '/rest/api/3/issueLink')).toBe(false);
  expect(store.saveTaskLinked).not.toHaveBeenCalled();
});

function withTypes(types, relates = () => true) {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation((path, options) => {
    if (path.startsWith('/rest/api/3/issue/createmeta/')) return Promise.resolve(response(200, { issueTypes: types, total: types.length }));
    if (path === '/rest/api/3/issueLinkType') return Promise.resolve(response(200, { issueLinkTypes: relates()
      ? [{ id: 'relates-id', name: 'Relates' }] : [] }));
    return original(path, options);
  });
}
const prepare = () => handler.prepareConcernTask({ context, payload: { capaId: '20002', decisionId } });

test('creation description matches the confirmed preview and omits account IDs and unsafe evidence', async () => {
  store.readDecision.mockResolvedValue({ ...concern, reason: 'Different weld cell', reasonCategory: 'OTHER',
    evidenceLinks: ['https://example.com/report', 'http://example.com/old', 'https://user:pass@example.com/private'] });
  const proposal = await prepare();
  expect(proposal.confirmation).toContain('Engineer reason: Different weld cell');
  expect(proposal.confirmation).toContain('Reason category: OTHER');
  expect(proposal.confirmation).not.toMatch(/server-account|user:pass/);
  expect(await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } }))
    .toHaveProperty('message', expect.stringContaining('linked it to QL-20002 and QL-10001'));
  const description = JSON.parse(requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issue')[1].body).fields.description;
  expect(description.type).toBe('doc'); expect(description.version).toBe(1);
  expect(descriptionPreview(description)).toContain('NC: QL-10001: Summary 10001');
  expect(descriptionPreview(description)).toContain('Different weld cell');
  expect(JSON.stringify(description)).not.toMatch(/server-account|user:pass|http:\/\/example.com\/old/);
});

test('every link write has new asUser reads of task, CAPA and NC after the previous write', async () => {
  await handler.createConcernTask({ context, payload: followup });
  let previousWrite = -1;
  requestJira.mock.calls.forEach(([path, options], index) => {
    if (!['POST', 'PUT'].includes(options?.method)) return;
    const reads = requestJira.mock.calls.slice(previousWrite + 1, index).map(([url]) => url);
    if (path === '/rest/api/3/issueLink') {
      for (const id of ['QL-30003', '20002', '10001']) expect(reads.some((url) => url.startsWith(`/rest/api/3/issue/${id}?`))).toBe(true);
    } else if (path === '/rest/api/3/issue') {
      for (const id of ['20002', '10001']) expect(reads.some((url) => url.startsWith(`/rest/api/3/issue/${id}?`))).toBe(true);
    }
    previousWrite = index;
  });
  expect(api.asUser).toHaveBeenCalledTimes(requestJira.mock.calls.length);
});

test('a Story-only project falls back to its first non-subtask type after a confirmation naming Story', async () => {
  withTypes([{ id: 'sub', name: 'Task', subtask: true }, { id: 'story', name: 'Story', subtask: false }, { id: 'bug', name: 'Bug', subtask: false }]);
  const proposal = await prepare();
  expect(proposal.confirmation).toContain('Create Story in QL');
  await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } });
  const created = JSON.parse(requestJira.mock.calls.find(([path]) => path === '/rest/api/3/issue')[1].body);
  expect(created.fields.issuetype).toEqual({ id: 'story' });
});

test('Task on a later metadata page is preferred to an earlier standard type', async () => {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation((path, options) => path.startsWith('/rest/api/3/issue/createmeta/')
    ? Promise.resolve(response(200, { total: 2, issueTypes: path.includes('startAt=0')
      ? [{ id: 'story', name: 'Story', subtask: false }] : [{ id: 'task', name: 'Task', subtask: false }] })) : original(path, options));
  expect((await prepare()).confirmation).toContain('Create Task in QL');
  expect(requestJira.mock.calls.some(([path]) => path.includes('startAt=1'))).toBe(true);
});

test('no standard issue type refuses creation before claiming', async () => {
  withTypes([{ id: 'sub', name: 'Subtask', subtask: true }]);
  expect(await prepare()).toHaveProperty('error', expect.stringContaining('No non-subtask'));
  expect(store.claimTask).not.toHaveBeenCalled();
});

test('missing Relates allows confirmed unlinked creation, and Verify later repairs both links idempotently', async () => {
  let relates = false;
  withTypes([{ id: '987', name: 'Task', subtask: false }], () => relates);
  const proposal = await prepare();
  expect(proposal.confirmation).toContain('Enable the Relates link type, or the task will be created unlinked.');
  const result = await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } });
  expect(result).toMatchObject({ taskKey: 'QL-30003', message: expect.stringContaining('with limits') });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(0);
  store.readDecision.mockResolvedValue(store.saveTaskMetadata.mock.calls[0][1]); relates = true;
  const repair = await handler.prepareRepairLink({ context, payload: repairPayload });
  const confirmed = { ...repairPayload, confirmation: repair.confirmation };
  expect(await handler.repairConcernLink({ context, payload: confirmed })).toHaveProperty('message', expect.stringContaining('both links are verified'));
  await handler.repairConcernLink({ context, payload: confirmed });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(2);
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
});

test('a description-only rejection retries under the same claim, saves the key, and Verify restores the missing description', async () => {
  const original = requestJira.getMockImplementation(); let rejected = false;
  requestJira.mockImplementation((path, options) => {
    if (path === '/rest/api/3/issue' && !rejected) { rejected = true; return Promise.resolve(response(400, { errors: { description: 'Not on screen' } })); }
    return original(path, options);
  });
  const result = await handler.createConcernTask({ context, payload: followup });
  expect(result).toMatchObject({ taskKey: 'QL-30003', message: expect.stringContaining('with limits: the description is missing') });
  expect(store.claimTask).toHaveBeenCalledTimes(1);
  const creates = requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue');
  expect(creates).toHaveLength(2);
  expect(JSON.parse(creates[0][1].body).fields).toHaveProperty('description.type', 'doc');
  expect(JSON.parse(creates[1][1].body).fields).not.toHaveProperty('description');
  store.readDecision.mockResolvedValue(store.saveTaskMetadata.mock.calls[0][1]);
  const repair = await handler.prepareRepairLink({ context, payload: repairPayload });
  expect(repair.confirmation).toContain('Set its description only if empty');
  await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: repair.confirmation } });
  expect(createdFields.description.type).toBe('doc');
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(2);
  expect(requestJira.mock.calls.filter(([path, options]) => path === '/rest/api/3/issue/30003' && options?.method === 'PUT')).toHaveLength(1);
});

test.each(['denial', 'transport'])('a partial NC-link %s saves the key and repairs only the missing link', async (failure) => {
  const original = requestJira.getMockImplementation(); let fail = true;
  requestJira.mockImplementation((path, options) => {
    if (fail && path === '/rest/api/3/issueLink' && JSON.parse(options.body).inwardIssue.id === '10001') {
      if (failure === 'transport') return Promise.reject(new Error('Transport failed'));
      return Promise.resolve(response(403));
    }
    return original(path, options);
  });
  expect(await handler.createConcernTask({ context, payload: followup }))
    .toMatchObject({ taskKey: 'QL-30003', message: expect.stringContaining('with limits') });
  expect(store.saveTaskLinked.mock.calls.map(([, , target]) => target)).toEqual(['description', 'capa']);
  store.readDecision.mockResolvedValue(store.saveTaskMetadata.mock.calls[0][1]); fail = false;
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: proposal.confirmation } });
  const links = requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink').map(([, options]) => JSON.parse(options.body).inwardIssue.id);
  expect(links).toEqual(['20002', '10001', '10001']);
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
});

test('Verify repairs an empty description and two absent links once, retaining exact confirmation on repeat', async () => {
  const task = repairScenario(); task.fields.issuelinks = []; task.fields.description = null;
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  const confirmed = { ...repairPayload, confirmation: proposal.confirmation };
  await handler.repairConcernLink({ context, payload: confirmed });
  await handler.repairConcernLink({ context, payload: confirmed });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(2);
  expect(requestJira.mock.calls.filter(([path, options]) => path === '/rest/api/3/issue/30003' && options?.method === 'PUT')).toHaveLength(1);
  expect(store.claimTask).not.toHaveBeenCalled();
});

test('failed description repair reports limits and retains the existing task while completing both links', async () => {
  const task = repairScenario(); task.fields.description = null; task.fields.issuelinks = [];
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation((path, options) => path === '/rest/api/3/issue/30003' && options?.method === 'PUT'
    ? Promise.resolve(response(403)) : original(path, options));
  const proposal = await handler.prepareRepairLink({ context, payload: repairPayload });
  const result = await handler.repairConcernLink({ context, payload: { ...repairPayload, confirmation: proposal.confirmation } });
  expect(result).toMatchObject({ taskKey: 'QL-30003', message: expect.stringContaining('with limits') });
  expect(result.message).toContain('the description could not be written');
  expect(store.saveTaskLinked.mock.calls.map(([, , target]) => target)).toEqual(['capa', 'nc']);
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(2);
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(0);
});

test('loss of NC browse access after the first link prevents the second write and returns no identifiers', async () => {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation(async (path, options) => {
    const result = await original(path, options);
    if (path === '/rest/api/3/issueLink') hidden.add('10001');
    return result;
  });
  expect(await handler.createConcernTask({ context, payload: followup })).toBeNull();
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issueLink')).toHaveLength(1);
  expect(store.saveTaskMetadata).toHaveBeenCalledWith(decisionId, expect.objectContaining({ taskKey: 'QL-30003' }));
});

test('a changed issue type or Relates plan requires a new exact confirmation before a claim', async () => {
  let available = true;
  withTypes([{ id: 'story', name: 'Story', subtask: false }], () => available);
  const proposal = await prepare(); available = false;
  expect(await handler.createConcernTask({ context, payload: { ...followup, confirmation: proposal.confirmation } }))
    .toHaveProperty('error', expect.stringContaining('proposed write changed'));
  expect(store.claimTask).not.toHaveBeenCalled();
});

test.each([
  [{ taskLinkedAt: claimedAt }, false],
  [{ taskLinkedAt: claimedAt, taskNcLinkedAt: claimedAt }, false],
  [{ taskLinkedAt: claimedAt, taskNcLinkedAt: claimedAt, taskDescriptionAt: claimedAt }, true],
])('history completion requires both links and description, including legacy records: %j', async (progress, complete) => {
  store.queryRecords.mockImplementation(async (entity) => ({ records: entity === 'decision'
    ? [{ id: decisionId, ...concern, taskKey: 'QL-30003', ...progress }] : [], incomplete: false }));
  const view = await handler.loadEvidence({ context });
  expect(view.pairs['20002'].history[0]).toMatchObject({ taskKey: 'QL-30003', taskLinked: complete });
});

test('an unrelated required field alongside description rejection never retries create', async () => {
  const original = requestJira.getMockImplementation();
  requestJira.mockImplementation((path, options) => path === '/rest/api/3/issue'
    ? Promise.resolve(response(400, { errors: { description: 'Unavailable', customfield_1: 'Required' } })) : original(path, options));
  await handler.createConcernTask({ context, payload: followup });
  expect(requestJira.mock.calls.filter(([path]) => path === '/rest/api/3/issue')).toHaveLength(1);
  expect(store.saveTaskMetadata).not.toHaveBeenCalled();
});


test('panel preview settings come from the current issue project', async () => {
  kvs.get.mockImplementation(async (key) => key === 'settings:123'
    ? { version: 3, scope: 'PROJECT', lookbackDays: 365, projectIds: [], revisionPreset: 'NONE' } : undefined);
  expect(await handler.getPanelAccess({ context })).toEqual({ canEdit: true, revisionPreset: 'NONE' });
  expect(kvs.get).toHaveBeenCalledWith('settings:123');
});

test.each([['R_DIGITS', true], ['NONE', false]])('decision eligibility recheck uses current NC preset %s, allowed=%s', async (revisionPreset, allowed) => {
  current = { ...nc, partOriginal: 'P-100-R12', partBase: 'OLD' };
  captured = { ...capa, partOriginal: 'P-100-R13', partBase: 'OTHER-OLD' };
  kvs.get.mockImplementation(async (key) => key === 'settings:123'
    ? { version: 3, scope: 'PROJECT', lookbackDays: 365, projectIds: [], revisionPreset } : undefined);
  const result = await handler.recordDecision({ context, payload });
  if (allowed) expect(store.commitDecision).toHaveBeenCalled();
  else {
    expect(store.commitDecision).not.toHaveBeenCalled();
    expect(result.error).toContain('no longer a strong or related revision match');
  }
});
