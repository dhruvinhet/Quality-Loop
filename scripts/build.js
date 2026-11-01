const { buildSync } = require('esbuild');
// Compile each entry with its actual imports; these temporary verification bundles
// are not the UI Kit resource (Forge handles native UI bundling at deploy time).
for (const [entry, platform] of [['src/frontend/index.jsx', 'browser'], ['src/frontend/issueContext.jsx', 'browser'],
  ['src/frontend/projectPage.jsx', 'browser'], ['src/frontend/adminPage.jsx', 'browser'], ['src/index.js', 'node']]) {
  buildSync({ entryPoints: [entry], bundle: true, packages: 'external', platform,
    target: platform === 'node' ? 'node22' : 'es2022', outdir: 'dist/verify' });
}
console.log('Checked UI Kit and resolver imports.');
