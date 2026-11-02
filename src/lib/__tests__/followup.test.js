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
test('confirmations list the intended ownership and the separate recovery write', () => {
  expect(followupConfirmation('QL', 'QL-2')).toContain('Intended assignee: unassigned');
  expect(followupConfirmation('QL', 'QL-2', { accountId: 'owner-id', displayName: 'CAPA Owner' })).toContain('CAPA Owner (owner-id)');
  expect(followupConfirmation('QL', 'QL-2')).toContain('If Jira rejects the assignee, create unassigned');
  expect(recoveryConfirmation('QL-3', 'QL-2')).toBe('Record QL-3 as the follow-up task for the recorded effectiveness concern on QL-2.');
});
