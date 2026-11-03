const { orphanClassification } = require('../cleanup');
test.each([
  [[200, 404], 'orphan'], [[404, 200], 'orphan'], [[404, 404], 'orphan'],
  [[200, 200], 'live'], [[200, 403], 'unknown'], [[403, 403], 'unknown'],
  [[200, 500], 'unknown'], [[0, 200], 'unknown'], [[429, 200], 'unknown'],
])('existence statuses %j classify as %s', (statuses, expected) => {
  expect(orphanClassification(['10', '20'], statuses, true)).toBe(expected);
});
test('malformed record references never authorise deletion', () => {
  expect(orphanClassification(['10'], [404])).toBe('unknown');
});

test.each([false, undefined, null])('a 404 with uncertain project-trash state (%s) never permits removal', (trashExcluded) => {
  expect(orphanClassification(['10', '20'], [200, 404], trashExcluded)).toBe('unknown');
});
