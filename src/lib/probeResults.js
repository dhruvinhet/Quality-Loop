export function summarise(rows) {
  const hits = rows.map((row) => row.searchHitMs).filter((ms) => typeof ms === 'number').sort((a, b) => a - b);
  const middle = Math.floor(hits.length / 2);
  return {
    min: hits.length ? hits[0] : null,
    median: hits.length ? (hits.length % 2 ? hits[middle] : (hits[middle - 1] + hits[middle]) / 2) : null,
    max: hits.length ? hits[hits.length - 1] : null,
    misses: rows.filter((row) => row.searchHitMs === 'miss').length,
    errors: rows.filter((row) => row.error).length,
  };
}

export function formatResults(rows) {
  const summary = summarise(rows);
  return [
    'QualityLoop E1: search-hit ms since frontend write acknowledgement; 1 s polls; 60 s deadline.',
    'write ms = resolver PUT round trip. Search timing includes readback, polling and bridge latency.',
    'run\ttoken\twrite ms\treadback ok\tsearch-hit ms\terror',
    ...rows.map((row) => [row.run, row.token, row.writeMs ?? '-', row.readbackOk ?? '-', row.searchHitMs ?? '-', row.error ?? ''].join('\t')),
    `min: ${summary.min ?? 'n/a'} ms; median: ${summary.median ?? 'n/a'} ms; max: ${summary.max ?? 'n/a'} ms; misses: ${summary.misses}; errors: ${summary.errors}`,
  ].join('\n');
}
