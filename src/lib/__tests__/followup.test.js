const { isRecoveryTask, recoveryJql, recoveryConfirmation } = require('../followup');
const { followupConfirmation } = require('../decisions');
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
