// Local dependency reachability only; this does not run the Forge packager.
// Run npm audit --omit=dev --json into dist/t15-audit-production.json first.
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const audit = JSON.parse(fs.readFileSync('dist/t15-audit-production.json', 'utf8').replace(/^\uFEFF/, ''));
if (!audit.vulnerabilities) throw new Error('A successful production audit report is required.');
const entries = [
  ['panel', 'src/frontend/index.jsx', 'browser'], ['side', 'src/frontend/issueContext.jsx', 'browser'],
  ['samples', 'src/frontend/projectPage.jsx', 'browser'], ['admin', 'src/frontend/adminPage.jsx', 'browser'],
  ['backend', 'src/index.js', 'node'],
];
const report = {};
fs.mkdirSync('dist/t15-bundle-audit', { recursive: true });
for (const [name, entry, platform] of entries) {
  const result = buildSync({ entryPoints: [entry], bundle: true, platform, target: platform === 'node' ? 'node24' : 'es2022',
    outfile: `dist/t15-bundle-audit/${name}.js`, metafile: true });
  const emitted = Object.values(result.metafile.outputs).flatMap((output) => Object.entries(output.inputs)
    .filter(([, info]) => info.bytesInOutput > 0).map(([path]) => path.replace(/\\/g, '/')));
  report[name] = Object.fromEntries(Object.entries(audit.vulnerabilities).map(([pkg, value]) => [pkg,
    emitted.some((path) => value.nodes.some((node) => path.startsWith(`${node}/`)))]));
  fs.writeFileSync(`dist/t15-bundle-audit/${name}.meta.json`, JSON.stringify(result.metafile));
}
fs.writeFileSync('dist/t15-bundle-audit/report.json', JSON.stringify(report, null, 2));
console.log('Local bundle reachability (deployed Forge bundle is unverified):');
console.log(JSON.stringify(report, null, 2));
