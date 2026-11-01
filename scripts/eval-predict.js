const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { buildSync } = require('esbuild');

async function main() {
  const { values } = parseArgs({
    options: { data: { type: 'string' }, corpus: { type: 'string' }, out: { type: 'string' } },
    allowPositionals: false,
  });
  if (!values.data || !values.corpus || !values.out) {
    throw new Error('Usage: node scripts/eval-predict.js --data <dir> --corpus <file> --out <file>');
  }

  // The app uses extensionless ES module imports. Bundle its actual pure source
  // in memory with the same local compiler used by the build and Jest; this
  // imports neither a resolver nor a Forge runtime and performs no network I/O.
  const { outputFiles } = buildSync({
    stdin: {
      contents: "export { buildCapture } from './src/lib/capture'; export { matchCaptures } from './src/lib/match';",
      resolveDir: path.resolve(__dirname, '..'),
    },
    bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
  });
  const { buildCapture, matchCaptures } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
  );

  // Read only NC inputs from the selected directory; labels and scorer source
  // are deliberately outside this harness's inputs.
  const { ncs } = JSON.parse(readFileSync(path.join(values.data, 'ncs.json'), 'utf8'));
  const { capas } = JSON.parse(readFileSync(values.corpus, 'utf8'));
  if (!Array.isArray(ncs) || !Array.isArray(capas)) {
    throw new Error('Expected an ncs array in the NC file and a capas array in the corpus.');
  }

  // Use the capture builder used on save, then add the metadata added by the
  // resolver. Explicit fields preserve the original part and exclude dataNote,
  // descriptions and any label-derived information from matching.
  function toRecord(record, recordType) {
    return {
      ...buildCapture({
        recordType, partNumber: record.part, failureMode: record.failureMode,
        supplier: record.supplier, line: record.line,
        detectedDate: record.detectedDate, closedDate: record.closedDate,
        rootCause: record.rootCause, actionsTaken: record.actionsTaken,
        effectivenessEvidenceUrl: record.effectivenessEvidenceUrl,
      }),
      id: record.id, key: record.id, summary: record.summary, status: record.jiraStatus,
    };
  }

  const candidates = capas.map((record) => toRecord(record, 'CAPA'));
  const predictions = Object.create(null);
  for (const record of ncs) {
    if (typeof record.id !== 'string' || !record.id || Object.hasOwn(predictions, record.id)) {
      throw new Error('Each NC must have a unique, nonempty string id.');
    }
    const { strong, relatedRevision } = matchCaptures(toRecord(record, 'NC'), candidates);
    predictions[record.id] = {
      strong: strong.map(({ id }) => id),
      relatedRevision: relatedRevision.map(({ id }) => id),
    };
  }
  mkdirSync(path.dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(predictions, null, 2)}\n`);
  console.log(`Wrote predictions for ${ncs.length} NCs to ${values.out}`);
}

main().catch((error) => {
  console.error(`eval-predict: ${error.message}`);
  process.exitCode = 1;
});
