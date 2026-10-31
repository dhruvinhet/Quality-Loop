const WAIT_MS = 1000;
const DEADLINE_MS = 60000;

function checked(result) {
  if (result == null || result.error) throw new Error(result?.error || 'Request unavailable. Check your issue access.');
  return result;
}

// The browser owns the loop: each resolver invocation makes just one Jira call.
export async function runProbes({ invoke, onRow, cancelled, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (let run = 1; run <= 20 && !cancelled(); run += 1) {
    const row = { run, token: `E1-${now()}-${run}`, writeMs: null, readbackOk: null, searchHitMs: null };
    onRow({ ...row });
    try {
      row.writeMs = checked(await invoke('probeWrite', { token: row.token })).writeMs;
      const writtenAt = now();
      if (cancelled()) return;
      onRow({ ...row });
      row.readbackOk = checked(await invoke('probeRead', { token: row.token })).readbackOk;
      if (cancelled()) return;
      onRow({ ...row });
      const deadline = writtenAt + DEADLINE_MS;
      let nextPollAt = now() + WAIT_MS;
      while (!cancelled() && now() < deadline) {
        await wait(Math.min(Math.max(0, nextPollAt - now()), deadline - now()));
        if (cancelled() || now() >= deadline) break;
        nextPollAt = now() + WAIT_MS;
        const remaining = deadline - now();
        let timeout;
        const pending = invoke('probeSearch', { token: row.token });
        let result;
        try {
          result = await Promise.race([
            pending,
            new Promise((resolve) => { timeout = setTimeout(() => resolve(null), remaining); }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        if (cancelled()) return;
        if (result === null && now() >= deadline) {
          row.searchHitMs = 'miss';
          onRow({ ...row });
          // Drain an outstanding request before the next sequential run.
          await pending.catch(() => {});
          break;
        }
        if (checked(result).hit && now() <= deadline) {
          row.searchHitMs = now() - writtenAt;
          break;
        }
      }
      if (cancelled()) return;
      if (row.searchHitMs === null) row.searchHitMs = 'miss';
    } catch (error) {
      if (cancelled()) return;
      row.error = error.message || 'Probe request failed.';
      row.searchHitMs = 'error';
    }
    onRow({ ...row });
  }
}
