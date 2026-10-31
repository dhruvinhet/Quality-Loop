const { transformSync } = require('esbuild');

module.exports = {
  process(sourceText, sourcePath) {
    return { code: transformSync(sourceText, {
      loader: sourcePath.endsWith('.jsx') ? 'jsx' : 'js',
      format: 'cjs', target: 'node22', sourcemap: 'inline', sourcefile: sourcePath,
    }).code };
  },
};
