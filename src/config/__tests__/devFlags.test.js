const devFlags = jest.requireActual('../devFlags');
const { readFileSync } = require('node:fs');
const path = require('node:path');

test('every development flag is explicitly false for release', () => {
  expect(Object.keys(devFlags).length).toBeGreaterThan(0);
  for (const [name, enabled] of Object.entries(devFlags)) {
    expect({ [name]: enabled }).toEqual({ [name]: false });
  }
});

test('the release manifest has exactly the four approved scopes', () => {
  const manifest = readFileSync(path.resolve(__dirname, '../../../manifest.yml'), 'utf8');
  const section = manifest.match(/^permissions:\r?\n {2}scopes:\r?\n([\s\S]*?)(?=^\S)/m);
  expect(section).not.toBeNull();
  const scopes = section[1].trim().split(/\r?\n/).map((line) => line.trim().replace(/^- /, ''));
  expect(scopes.sort()).toEqual(['read:jira-work', 'write:jira-work', 'storage:app', 'read:jira-user'].sort());
});
