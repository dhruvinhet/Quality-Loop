import { kvs } from '@forge/kvs';
import { RECORD_ENTITIES } from '../lib/cleanup';
import { recordPage, deleteRecordBatch } from './cleanupStore';
import { checkOrphan } from './orphanChecks';
import { BudgetExceeded, loadBudget } from './loadBudget';
import { readTicket } from './pageUtils';

export const HEALTH_PREFIX = 'data-health';
const HEALTH_POLICY_VERSION = 2;
const ttl = { ttl: { unit: 'HOURS', value: 1 } };
const batchKey = (token, index) => `${HEALTH_PREFIX}-batch:${token}:${index}`;
export const initialHealth = () => ({ policyVersion: HEALTH_POLICY_VERSION, phase: 'scan', entityIndex: 0, scanned: 0, found: 0, unknown: 0,
  batches: 0, scanComplete: false, removed: 0, retained: 0, deleteBatch: 0, removeComplete: false });
export const healthSummary = (state) => ({ scanned: state.scanned, found: state.found, unknown: state.unknown,
  scanComplete: state.scanComplete, removed: state.removed, retained: state.retained, removeComplete: state.removeComplete });

// Serialise tabs/retries for this account-bound ticket, using the same atomic
// FAIL_IF_EXISTS lock pattern as sample maintenance. A new scan has a new lock.
export async function withHealthTicket(context, token, work) {
  if (!await readTicket(HEALTH_PREFIX, token, context)) return { error: 'This data health check expired. Start a new check.' };
  const lock = `${HEALTH_PREFIX}-lock:${token}`;
  try {
    await kvs.set(lock, true, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'MINUTES', value: 1 } });
  } catch { return { error: 'This check is already running or unavailable. Resume it after the current request finishes.' }; }
  try {
    const state = await readTicket(HEALTH_PREFIX, token, context);
    if (!state) return { error: 'This data health check expired. Start a new check.' };
    if (state.policyVersion !== HEALTH_POLICY_VERSION) return { error: 'Trash protection changed. Start a new data health check before reviewing or removing records.' };
    const result = await work(state);
    if (result?.error) return result;
    await kvs.set(`${HEALTH_PREFIX}:${token}`, state, ttl);
    return { ...healthSummary(state), ...result };
  } finally { await kvs.delete(lock); }
}

// At most one ten-record storage page per invocation. Only IDs/progress are
// checkpointed; pending records are directly re-read on every resumed operation.
export async function scanHealthPage(token, state, budget = loadBudget(12000)) {
  if (state.phase !== 'scan' || state.scanComplete) return {};
  const found = [];
  let paused = false;
  try {
    if (!state.pending) {
      const entity = RECORD_ENTITIES[state.entityIndex];
      const page = await recordPage(entity, state.cursor, 'by-key', undefined, budget);
      state.pending = page.records.map(({ key }) => ({ entity, key }));
      state.pageNext = page.nextCursor;
    }
    while (state.pending.length) {
      const { entity, key } = state.pending[0];
      const value = await budget.run(() => kvs.entity(entity).get(key));
      if (value) {
        const status = await checkOrphan({ entity, key, value }, budget);
        state.scanned += 1;
        if (status === 'orphan') found.push({ entity, key });
        if (status === 'unknown') state.unknown += 1;
      }
      state.pending.shift();
    }
    delete state.pending;
    if (state.pageNext) state.cursor = state.pageNext;
    else { state.entityIndex += 1; delete state.cursor; }
    delete state.pageNext;
    state.scanComplete = state.entityIndex === RECORD_ENTITIES.length;
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    paused = true;
  }
  if (found.length) {
    await kvs.set(batchKey(token, state.batches), { records: found }, ttl);
    state.batches += 1;
    state.found += found.length;
  }
  return { paused, recordIds: found.map(({ entity, key }) => `${entity}/${key}`) };
}

export async function removeHealthPage(token, state, budget = loadBudget(12000)) {
  if (state.removeComplete) return {};
  state.phase = 'remove';
  let paused = false;
  try {
    if (!state.pendingDelete && state.deleteBatch < state.batches) {
      const batch = await budget.run(() => kvs.get(batchKey(token, state.deleteBatch)));
      // Never silently skip expired or missing review data.
      if (!batch?.records) return { error: 'The reviewed records expired. Start a new data health check.' };
      state.pendingDelete = batch.records;
    }
    while (state.pendingDelete?.length) {
      const { entity, key } = state.pendingDelete[0];
      const value = await budget.run(() => kvs.entity(entity).get(key));
      if (value) {
        const status = await checkOrphan({ entity, key, value }, budget);
        if (status === 'orphan') {
          budget.check();
          // Writes are awaited, never raced with a timeout that can publish late.
          await deleteRecordBatch([{ entity, key, value }]);
          state.removed += 1;
        } else state.retained += 1;
      }
      state.pendingDelete.shift();
    }
    if (state.pendingDelete) { delete state.pendingDelete; state.deleteBatch += 1; }
    state.removeComplete = state.deleteBatch >= state.batches;
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    paused = true;
  }
  return { paused };
}
