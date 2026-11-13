const { isRecoveryTask, recoveryJql, recoveryConfirmation, followupMarker, recoveryMarkerKind, hasCapaLink, repairLinkConfirmation } = require('../followup');
const { followupConfirmation } = require('../decisions');
const { followupDescription, descriptionPreview, hasDescription } = require('../followup');
const claim = '2026-10-21T12:13:14.567Z';
const task = { fields: { project: { id: '123' }, summary: 'Effectiveness re-review: QL-2', created: '2026-10-21T12:13:14.568Z' } };

test('recovery query bounds the project, summary phrase and timezone-safe date window', () => {
  expect(recoveryJql('123', 'QL-2', claim)).toBe('project = "123" AND summary ~ "\\"Effectiveness re-review: QL-2\\"" AND created >= "2026-10-20" ORDER BY created DESC, key ASC');
  expect(() => recoveryJql('123 OR project=1', 'QL-2', claim)).toThrow();
  expect(() => recoveryJql('123', 'QL-2', 'invalid')).toThrow();
});
test('direct recovery requires exact summary, same project and creation strictly after the claim', () => {
  expect(isRecoveryTask(task, '123', 'QL-2', claim)).toBe(true);
  for (const patch of [{ created: claim }, { created: 'invalid' }, { project: { id: '456' } }, { summary: 'Effectiveness re-review: QL-2 extra' }]) {
    expect(isRecoveryTask({ fields: { ...task.fields, ...patch } }, '123', 'QL-2', claim)).toBe(false);
  }
  expect(isRecoveryTask(null, '123', 'QL-2', claim)).toBe(false);
});
test('unassigned confirmations omit the redundant rejection fallback', () => {
  for (const assignee of [undefined, null, {}]) {
    const confirmation = followupConfirmation('QL', 'QL-2', assignee);
    expect(confirmation.endsWith('Assignee: none (the CAPA has no assignee).')).toBe(true);
    expect(confirmation).not.toContain('If Jira rejects');
  }
});

test('assigned confirmations explain the fallback without exposing account IDs', () => {
  const named = followupConfirmation('QL', 'QL-2', { accountId: 'owner-id', displayName: 'CAPA Owner' });
  expect(named).toContain('Intended assignee: CAPA Owner. If Jira rejects this assignee, the task is created unassigned.');
  expect(named).not.toContain('owner-id');
  for (const displayName of [undefined, null, '', '   ']) {
    const unnamed = followupConfirmation('QL', 'QL-2', { accountId: 'owner-id', displayName });
    expect(unnamed).toContain("Intended assignee: the CAPA's current assignee. If Jira rejects this assignee, the task is created unassigned.");
    expect(unnamed).not.toContain('owner-id');
  }
});

test('recovery confirmation lists the separate recording write', () => {
  expect(recoveryConfirmation('QL-3', 'QL-2')).toBe('Record QL-3 as the follow-up task for the recorded effectiveness concern on QL-2.');
});

const decision = { capaId: '2', issueId: '1', taskClaimedAt: claim, taskMarkerVersion: 1 };
test('v1 legacy marker records the exact decision, CAPA, NC and durable claim time and still recovers', () => {
  expect(followupMarker('2:1:decision', decision)).toEqual({ schemaVersion: 1, decisionId: '2:1:decision', capaId: '2', ncId: '1', claimedAt: claim });
  expect(recoveryMarkerKind({ properties: { 'qualityloop-followup': followupMarker('2:1:decision', decision) } }, '2:1:decision', decision)).toBe('marked');
});

test('v2 marker contains only an opaque token and recovery requires its exact stored value', () => {
  const token = 'a0b1c2d3e4f56789a0b1c2d3e4f56789';
  const current = { ...decision, taskMarkerVersion: 2, taskMarkerToken: token };
  const marker = followupMarker('2:1:decision', current);
  expect(marker).toEqual({ schemaVersion: 2, token });
  expect(Object.keys(marker).sort()).toEqual(['schemaVersion', 'token']);
  const marked = (value) => ({ properties: { 'qualityloop-followup': value } });
  expect(recoveryMarkerKind(marked(marker), '2:1:decision', current)).toBe('marked');
  for (const invalid of [{ ...marker, token: 'f'.repeat(32) }, { schemaVersion: 2 }, followupMarker('2:1:decision', decision)]) {
    expect(recoveryMarkerKind(marked(invalid), '2:1:decision', current)).toBeNull();
  }
  expect(recoveryMarkerKind(task, '2:1:decision', current)).toBeNull();
  expect(recoveryMarkerKind(task, '2:1:decision', { ...current, taskMarkerVersion: undefined })).toBeNull();
  expect(recoveryMarkerKind(marked(marker), '2:1:decision', { ...current, taskMarkerToken: undefined })).toBeNull();
});
test.each([{ decisionId: 'other' }, { capaId: '3' }, { ncId: '4' }, { schemaVersion: 2 }, { claimedAt: 'other' }])(
  'a present conflicting marker never becomes a legacy candidate: %j', (patch) => {
    const marked = { properties: { 'qualityloop-followup': { ...followupMarker('2:1:decision', decision), ...patch } } };
    expect(recoveryMarkerKind(marked, '2:1:decision', decision)).toBeNull();
    expect(recoveryMarkerKind(marked, '2:1:decision', { ...decision, taskMarkerVersion: undefined })).toBeNull();
  });
test('only old claims allow unmarked tasks, with an explicit legacy warning', () => {
  expect(recoveryMarkerKind(task, '2:1:decision', decision)).toBeNull();
  expect(recoveryMarkerKind(task, '2:1:decision', { ...decision, taskMarkerVersion: undefined })).toBe('legacy');
  expect(recoveryMarkerKind({ properties: { 'qualityloop-followup': null } }, '2:1:decision', decision)).toBeNull();
  expect(recoveryConfirmation('QL-3', 'QL-2', true)).toContain('This task has no QualityLoop marker; confirm only if you know it is the follow-up task.');
  expect(repairLinkConfirmation('QL-3', 'QL-2', { ncKey: 'QL-1', description: 'Details' }))
    .toContain('Check Relates links to CAPA QL-2 and NC QL-1; add each link only if missing.');
});
test.each(['inwardIssue', 'outwardIssue'])('Relates links to the CAPA are recognised in %s', (direction) => {
  const links = (type, issue) => ({ fields: { issuelinks: [{ type: { name: type }, [direction]: issue }] } });
  expect(hasCapaLink(links('Relates', { id: '2' }), { id: '2', key: 'QL-2' })).toBe(true);
  expect(hasCapaLink(links('Relates', { key: 'QL-2' }), { id: '2', key: 'QL-2' })).toBe(true);
  expect(hasCapaLink(links('Blocks', { id: '2' }), { id: '2', key: 'QL-2' })).toBe(false);
  expect(hasCapaLink(links('Relates', { id: '3' }), { id: '2', key: 'QL-2' })).toBe(false);
});

test('ADF description contains the decision, linked NC summary, reason/category, safe evidence and history instruction only', () => {
  const description = followupDescription({ type: 'CONCERN', authorAccountId: 'private-account-id', reason: 'Different weld cell',
    reasonCategory: 'DATA_ERROR', evidenceLinks: ['https://example.com/report', 'http://example.com/old',
      'https://user:pass@example.com/private', 'javascript:alert(1)'] },
  { key: 'QL-1', self: 'https://site.atlassian.net/rest/api/3/issue/1', fields: { summary: 'Cracked weld' } }, { key: 'QL-2' });
  expect(description).toEqual({ type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Decision: Effectiveness concern' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'NC: ' }, { type: 'text', text: 'QL-1: Cracked weld',
      marks: [{ type: 'link', attrs: { href: 'https://site.atlassian.net/browse/QL-1' } }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'CAPA: QL-2' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Engineer reason: Different weld cell' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Reason category: DATA_ERROR' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'https://example.com/report',
      marks: [{ type: 'link', attrs: { href: 'https://example.com/report' } }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Open the QualityLoop panel on QL-1 to see the full history.' }] },
  ] });
  expect(JSON.stringify(description)).not.toMatch(/private-account-id|accountId|user:pass|javascript:|\/old/);
  expect(descriptionPreview(description)).toContain('NC: QL-1: Cracked weld');
});

test('repair recognises nonempty rich content and never treats it as an empty description', () => {
  for (const description of [null, { type: 'doc', version: 1, content: [] },
    { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] }]) {
    expect(hasDescription({ fields: { description } })).toBe(false);
  }
  for (const description of ['Existing owner notes', { type: 'doc', version: 1, content: [{ type: 'bulletList', content: [] }] }]) {
    expect(hasDescription({ fields: { description } })).toBe(true);
  }
});

test('missing Relates and fallback issue type are explicit in creation and repair confirmations', () => {
  const proposal = followupConfirmation('QL', 'QL-2', null,
    { ncKey: 'QL-1', typeName: 'Story', description: 'Engineer reason: Review', linkAvailable: false });
  expect(proposal).toContain('Create Story in QL');
  expect(proposal).toContain('Enable the Relates link type, or the task will be created unlinked.');
  expect(proposal).toContain('Set an ADF description: Engineer reason: Review');
  const repair = repairLinkConfirmation('QL-3', 'QL-2', { ncKey: 'QL-1', description: 'Details', linkAvailable: false });
  expect(repair).toBe('Verify QL-3. Set its ADF description only if empty: Details. Check Relates links to CAPA QL-2 and NC QL-1; add each link only if missing. Record description and both link completions. Enable the Relates link type; missing links cannot be repaired until it is available.');
});
