// Static dependency inclusion evidence, not a replacement for Forge's bundler
// or a proof that an advisory's vulnerable function is invoked by the app.
const { buildSync } = require('esbuild');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const packages = ['glob', 'minimatch', 'markdown-it', 'prosemirror-view'];
const entries = ['src/index.js', 'src/frontend/index.jsx', 'src/frontend/issueContext.jsx',
  'src/frontend/projectPage.jsx', 'src/frontend/adminPage.jsx'];
const reports = entries.map((entry) => {
  const result = buildSync({ entryPoints: [entry], bundle: true, platform: entry === 'src/index.js' ? 'node' : 'browser',
    target: 'es2022', write: false, metafile: true, treeShaking: true, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs);
  const included = Object.fromEntries(packages.map((name) => [name,
    inputs.filter((file) => file.replaceAll('\\', '/').includes(`/node_modules/${name}/`) || file.startsWith(`node_modules/${name}/`))]));
  return { entry, included, inputCount: inputs.length };
});
const outdir = path.resolve('dist/t19');
mkdirSync(outdir, { recursive: true });
writeFileSync(path.join(outdir, 'bundle-inclusion.json'), JSON.stringify(reports, null, 2) + '\n');
for (const report of reports) console.log(report.entry, JSON.stringify(Object.fromEntries(
  Object.entries(report.included).map(([name, files]) => [name, files.length]))));
