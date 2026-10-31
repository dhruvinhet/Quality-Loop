import { randomUUID } from 'node:crypto';
import { kvs, Filter, FilterConditions } from '@forge/kvs';
import { decisionKey, emptyPairState, nextState, pairKey } from '../lib/decisions';

// Entity names must be lowercase in Forge; pair-state implements logical pairState.
export const PAIR_ENTITY = 'pair-state';
export const DECISION_ENTITY = 'decision';
export const getPairState = async (capaId, issueId) =>
  (await kvs.entity(PAIR_ENTITY).get(pairKey(capaId, issueId))) ?? emptyPairState();

export async function commitDecision({ issueId, authorAccountId, payload, capa }) {
  const key = pairKey(payload.capaId, issueId);
  const previous = await getPairState(payload.capaId, issueId); // strictly consistent; never a query
  if (previous.version !== payload.expectedVersion) return { conflict: true, pairState: previous };
  const state = nextState(payload.type, previous.version ? previous : null, capa);
  const now = new Date();
  const id = decisionKey(payload.capaId, issueId, `${String(now.getTime()).padStart(13, '0')}-${randomUUID()}`);
  const decision = {
    type: payload.type, capaId: payload.capaId, issueId, reason: payload.reason.trim(),
    ...(payload.type === 'NOT_RECURRENCE' ? { reasonCategory: payload.reasonCategory } : {}),
    evidenceLinks: payload.evidenceLinks, authorAccountId, createdAt: now.toISOString(),
  };
  const pairState = { version: previous.version + 1, state, latestDecisionId: id, updatedAt: decision.createdAt,
    capaId: payload.capaId, issueId };
  // All records have a version. notExists(version) therefore admits only a new pair.
  const conditions = new Filter().and('version', payload.expectedVersion === 0
    ? FilterConditions.notExists() : FilterConditions.equalTo(payload.expectedVersion));
  try {
    await kvs.transact()
      .set(key, pairState, { entityName: PAIR_ENTITY, conditions })
      .set(id, decision, { entityName: DECISION_ENTITY })
      .execute();
  } catch (error) {
    // Do not guess a Forge error code. Reconcile an uncertain response with direct
    // reads: our immutable decision proves commit; a changed version proves conflict.
    const committed = await kvs.entity(DECISION_ENTITY).get(id);
    if (committed) return { success: true, pairState, decision: { id, ...committed } };
    const current = await getPairState(payload.capaId, issueId);
    if (current.version !== payload.expectedVersion) return { conflict: true, pairState: current };
    throw error;
  }
  return { success: true, pairState, decision: { id, ...decision } };
}

export async function queryDecisions(index, partition) {
  const records = [];
  let cursor;
  do {
    let query = kvs.entity(DECISION_ENTITY).query().index(index, { partition: [partition] }).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    records.push(...page.results.map(({ key, value }) => ({ id: key, ...value })));
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}

// A durable claim prevents duplicate Jira tasks from repeated bridge calls.
// There is no automatic retry after an ambiguous Jira response.
export async function claimTask(id, decision) {
  const taskClaimId = randomUUID();
  const claimed = { ...decision, taskClaimId };
  try {
    await kvs.transact().set(id, claimed, { entityName: DECISION_ENTITY,
      conditions: new Filter().and('taskClaimId', FilterConditions.notExists()) }).execute();
    return claimed;
  } catch (error) {
    const current = await kvs.entity(DECISION_ENTITY).get(id);
    if (current?.taskClaimId) return null;
    throw error;
  }
}
export const readDecision = (id) => kvs.entity(DECISION_ENTITY).get(id);
export const saveTaskMetadata = (id, decision) => kvs.entity(DECISION_ENTITY).set(id, decision);
