const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
test.each(['manifest.yml', 'README.md'])('%s contains no scaffold branding', (file) => {
  expect(readFileSync(path.join(root, file), 'utf8')).not.toMatch(/hello-world/i);
});

test('the panel icon resolves to a bundled, self-contained SVG', () => {
  const manifest = readFileSync(path.join(root, 'manifest.yml'), 'utf8');
  const icon = manifest.match(/^ {6}icon: resource:([\w-]+);([^\s]+)$/m);
  expect(icon).not.toBeNull();
  const resources = manifest.split(/^resources:\r?\n/m)[1].split(/^permissions:/m)[0];
  const directory = resources.match(new RegExp(`- key: ${icon[1]}\\r?\\n +path: (\\S+)`));
  expect(directory).not.toBeNull();
  const iconPath = path.join(root, directory[1], icon[2]);
  expect(existsSync(iconPath)).toBe(true);
  const svg = readFileSync(iconPath, 'utf8');
  expect(svg).toMatch(/<svg\s/);
  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).not.toMatch(/<script|<image|(?:href|src)=/i);
});
