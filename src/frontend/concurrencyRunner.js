export async function runConcurrencyCheck({ invoke, capaId, onRound = () => {}, cancelled = () => false }) {
  const initial = await invoke('e8PairState', { capaId });
  if (!initial?.pairState) throw new Error(initial?.error || 'Pair state is unavailable.');
  const startingVersion = initial.pairState.version;
  let expectedVersion = startingVersion;
  const rounds = [];
  for (let round = 1; round <= 10; round += 1) {
    if (cancelled()) throw new Error('Concurrency test stopped because the card was closed. Refresh history before testing again.');
    const payload = { capaId, expectedVersion, type: 'CONFIRM', reason: `E8 concurrency test, round ${round}`, evidenceLinks: [] };
    const results = await Promise.allSettled([invoke('recordDecision', payload), invoke('recordDecision', payload)]);
    const success = results.filter((r) => r.status === 'fulfilled' && r.value?.success === true).length;
    const conflict = results.filter((r) => r.status === 'fulfilled' && r.value?.conflict === true).length;
    const current = await invoke('e8PairState', { capaId });
    const row = { round, expectedVersion, success, conflict, version: current?.pairState?.version,
      pass: success === 1 && conflict === 1 && current?.pairState?.version === expectedVersion + 1 };
    rounds.push(row); onRound(row);
    if (!Number.isInteger(current?.pairState?.version)) throw new Error('Pair state could not be verified. Refresh history.');
    expectedVersion = current.pairState.version;
  }
  const successfulWrites = rounds.reduce((sum, row) => sum + row.success, 0);
  const conflicts = rounds.reduce((sum, row) => sum + row.conflict, 0);
  const final = await invoke('e8PairState', { capaId });
  const totalSuccessfulWrites = startingVersion + successfulWrites;
  return { rounds, startingVersion, successfulWrites, totalSuccessfulWrites, conflicts, version: final?.pairState?.version,
    pass: rounds.every((row) => row.pass) && final?.pairState?.version === totalSuccessfulWrites };
}
