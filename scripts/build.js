const { buildSync } = require('esbuild');
const { copyFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const output = path.join(__dirname, '../static/probe-clipboard/dist');
mkdirSync(output, { recursive: true });
buildSync({
  entryPoints: [path.join(__dirname, '../static/probe-clipboard/src/index.js')],
  outfile: path.join(output, 'index.js'),
  bundle: true, minify: true, platform: 'browser', target: 'es2022',
});
for (const file of ['index.html', 'styles.css']) {
  copyFileSync(path.join(__dirname, '../static/probe-clipboard/src', file), path.join(output, file));
}
// Compile each entry with its actual imports; these temporary verification bundles
// are not the UI Kit resource (Forge handles native UI bundling at deploy time).
for (const [entry, platform] of [['src/frontend/index.jsx', 'browser'], ['src/frontend/issueContext.jsx', 'browser'],
  ['src/frontend/projectPage.jsx', 'browser'], ['src/frontend/adminPage.jsx', 'browser'], ['src/index.js', 'node']]) {
  buildSync({ entryPoints: [entry], bundle: true, packages: 'external', platform,
    target: platform === 'node' ? 'node22' : 'es2022', outdir: 'dist/verify' });
}
console.log('Built probe clipboard resource; checked UI Kit and resolver imports.');
