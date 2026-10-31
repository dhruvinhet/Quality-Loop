// elapsedMs is deliberately excluded from equality; all evidence is compared.
export async function runMatchCheck({ invoke, cancelled = () => false, onProgress = () => {} }) {
  const results = [];
  for (let index = 0; index < 20; index += 1) {
    if (cancelled()) return null;
    const result = await invoke('findMatches');
    if (cancelled()) return null;
    if (!result?.applicable || result.error || !Number.isFinite(result.elapsedMs)) {
      throw new Error(result?.error || 'Open a saved NC with a detected date and check issue access.');
    }
    results.push(result);
    onProgress(results.length);
  }
  const content = results.map(({ elapsedMs, ...evidence }) => JSON.stringify(evidence));
  const times = results.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  return { runs: 20, identical: content.every((value) => value === content[0]),
    min: times[0], median: (times[9] + times[10]) / 2, max: times[19], results };
}
