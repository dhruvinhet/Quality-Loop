export async function callPage(invoke, name, payload = {}) {
  const result = await invoke(name, payload);
  if (!result) throw new Error('This operation is unavailable with your current permissions.');
  if (result.error) throw new Error(result.error);
  return result;
}

export async function pollSampleReady(check, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + 30000;
  do {
    const result = await check();
    if (result.ready) return result;
    if (now() + 2000 > deadline) break;
    await sleep(2000);
  } while (now() <= deadline);
  return { ready: false };
}

export async function scanRecordPages(visit) {
  for (const entity of ['decision', 'pair-state']) {
    let cursor;
    do {
      const result = await visit(entity, cursor);
      cursor = result.nextCursor;
    } while (cursor);
  }
}
