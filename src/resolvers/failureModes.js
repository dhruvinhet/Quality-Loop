import { randomUUID } from 'node:crypto';
import { kvs } from '@forge/kvs';
import { seedCatalogue, validCatalogue, changeCatalogue } from '../lib/failureModes';
import { pageDefine, requireAdmin } from './pageUtils';

// Forge namespaces KVS by installation/site/environment; no payload site ID.
export const CATALOGUE_KEY = 'fm-catalog:site';
const LOCK_KEY = `${CATALOGUE_KEY}:lock`;
export async function readFailureModes() {
  const stored = await kvs.get(CATALOGUE_KEY);
  if (stored === undefined) return seedCatalogue();
  if (!validCatalogue(stored)) throw new Error('Failure-mode catalogue is invalid.');
  return stored;
}
export function registerFailureModeAdmin(resolver) {
  pageDefine(resolver, 'getFailureModeCatalogue', [], async (context) => {
    if (!await requireAdmin(context)) return null;
    return readFailureModes();
  });
  pageDefine(resolver, 'changeFailureMode', ['action', 'code', 'label', 'expectedVersion'], async (context, payload) => {
    if (!await requireAdmin(context)) return null;
    const token = randomUUID();
    try {
      await kvs.set(LOCK_KEY, { token }, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'MINUTES', value: 5 } });
    } catch { return { error: 'The catalogue is busy or unavailable. Refresh before retrying; an interrupted edit may hold the lock until expiry.' }; }
    try {
      const current = await readFailureModes();
      if (payload.expectedVersion !== current.version) return { error: 'The catalogue changed. Refresh before editing again.' };
      let next;
      try { next = changeCatalogue(current, payload); }
      catch (error) { return { error: error.message }; }
      if (!await requireAdmin(context)) return null;
      if ((await kvs.get(LOCK_KEY))?.token !== token) return { error: 'The edit lock was lost. Refresh before editing again.' };
      await kvs.set(CATALOGUE_KEY, next);
      return next;
    } finally {
      if ((await kvs.get(LOCK_KEY))?.token === token) await kvs.delete(LOCK_KEY);
    }
  });
}
