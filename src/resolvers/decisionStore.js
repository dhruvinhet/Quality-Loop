import { randomBytes, randomUUID } from 'node:crypto';
import { kvs, Filter, FilterConditions, Sort } from '@forge/kvs';
import { confirmedAfter, confirmedFromHistory, decisionKey, emptyPairState, nextState, pairKey } from '../lib/decisions';
import { loadBudget } from './loadBudget';

// Entity names must be lowercase in Forge; pair-state implements logical pairState.
export const PAIR_ENTITY = 'pair-state';
export const DECISION_ENTITY = 'decision';
// Essential state/version reads never depend on aggregate counts or legacy history.
export async function getPairState(capaId, issueId, budget) {
  const read = () => kvs.entity(PAIR_ENTITY).get(pairKey(capaId, issueId));
  return (await (budget ? budget.run(read) : read())) ?? emptyPairState();
}

export async function commitDecision({ issueId, authorAccountId, payload, capa }) {
  const key = pairKey(payload.capaId, issueId);
  const previous = await getPairState(payload.capaId, issueId); // strictly consistent; never a query
  if (previous.version !== payload.expectedVersion) return { conflict: true, pairState: previous };
  const state = nextState(payload.type, previous.version ? previous : null, capa);
  const confirmed = confirmedAfter(payload.type, ['CONFIRM', 'NOT_RECURRENCE'].includes(payload.type)
    ? false : await pairConfirmed(previous, payload.capaId, issueId));
  // Preserve chronological ordering even for sequential decisions in one ms.
  const previousTime = Date.parse(previous.updatedAt ?? '');
  const now = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0));
  const id = decisionKey(payload.capaId, issueId, `${String(now.getTime()).padStart(13, '0')}-${randomUUID()}`);
  const decision = {
    type: payload.type, capaId: payload.capaId, issueId, reason: payload.reason.trim(),
    ...(payload.type === 'NOT_RECURRENCE' ? { reasonCategory: payload.reasonCategory } : {}),
    evidenceLinks: payload.evidenceLinks, authorAccountId, createdAt: now.toISOString(),
  };
  const pairState = { version: previous.version + 1, state, latestDecisionId: id, updatedAt: decision.createdAt,
    capaId: payload.capaId, issueId, confirmed };
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

// Bounded UI queries. In-memory filters can return empty intermediate pages.
export async function queryRecords(entity, index, partition, { limit = 50, capaId, budget = loadBudget() } = {}) {
  const records = [];
  let cursor;
  for (let pages = 0; pages < 10; pages += 1) {
    let query = kvs.entity(entity).query().index(index, { partition: [partition] }).sort(Sort.DESC).limit(Math.min(100, limit - records.length));
    if (capaId) query = query.filters(new Filter().and('capaId', FilterConditions.equalTo(capaId)));
    if (cursor) query = query.cursor(cursor);
    const page = await budget.run(() => query.getMany());
    records.push(...page.results.map(({ key, value }) => ({ id: key, ...value })).slice(0, limit - records.length));
    cursor = page.nextCursor;
    if (!cursor || records.length >= limit) break;
  }
  return { records, incomplete: !!cursor };
}

export async function pairConfirmed(pair, capaId, issueId, budget = loadBudget(), knownHistory) {
  if (typeof pair.confirmed === 'boolean') return pair.confirmed;
  if (!pair.version) return false;
  const history = knownHistory ?? await queryRecords(DECISION_ENTITY, 'by-issue', issueId, { capaId, limit: 100, budget });
  if (pair.latestDecisionId && !history.records.some(({ id }) => id === pair.latestDecisionId)) {
    const latest = await budget.run(() => readDecision(pair.latestDecisionId));
    if (latest?.capaId === capaId && latest.issueId === issueId) history.records.push({ ...latest, id: pair.latestDecisionId });
  }
  const ownHistory = history.records.filter((record) => record.capaId === capaId && record.issueId === issueId);
  if (history.incomplete && !ownHistory.some(({ type }) => ['CONFIRM', 'NOT_RECURRENCE'].includes(type))) {
    throw new Error('Legacy confirmation history is incomplete. Retry after reviewing older decisions.');
  }
  const confirmed = confirmedFromHistory(ownHistory);
  budget.check();
  try {
    await kvs.transact().set(pairKey(capaId, issueId), { ...pair, capaId, issueId, confirmed }, {
      entityName: PAIR_ENTITY, conditions: new Filter().and('version', FilterConditions.equalTo(pair.version))
        .and('confirmed', FilterConditions.notExists()),
    }).execute();
  } catch (error) {
    const current = await budget.run(() => getPairState(capaId, issueId));
    if (typeof current.confirmed === 'boolean') return current.confirmed;
    if (current.version !== pair.version) return pairConfirmed(current, capaId, issueId, budget);
    throw error;
  }
  return confirmed;
}

// A durable claim prevents duplicate Jira tasks from repeated bridge calls.
// There is no automatic retry after an ambiguous Jira response.
export async function claimTask(id, decision) {
  const taskClaimId = randomUUID();
  const claimed = { ...decision, taskClaimId, taskClaimedAt: new Date().toISOString(),
    taskMarkerVersion: 2, taskMarkerToken: randomBytes(16).toString('hex') };
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
export async function saveTaskMetadata(id, decision) {
  try {
    await kvs.transact().set(id, decision, { entityName: DECISION_ENTITY,
      conditions: new Filter().and('taskClaimId', FilterConditions.equalTo(decision.taskClaimId))
        .and('taskKey', FilterConditions.notExists()),
    }).execute();
    return true;
  } catch (error) {
    const current = await readDecision(id);
    if (current?.taskClaimId !== decision.taskClaimId) return false;
    if (current?.taskKey) return current.taskKey === decision.taskKey;
    throw error;
  }
}

// Update only link completion on the current record, never replace it with a
// stale history snapshot. Reconcile a lost transaction response by direct read.
export async function saveTaskLinked(id, decision, target = 'capa') {
  const fields = { capa: 'taskLinkedAt', nc: 'taskNcLinkedAt', description: 'taskDescriptionAt' };
  const field = fields[target];
  if (!field) throw new Error('Invalid follow-up completion target.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readDecision(id);
    if (!current || current.taskClaimId !== decision.taskClaimId || current.taskKey !== decision.taskKey) return false;
    if (current[field]) return true;
    let conditions = new Filter().and('taskClaimId', FilterConditions.equalTo(decision.taskClaimId))
      .and('taskKey', FilterConditions.equalTo(decision.taskKey)).and(field, FilterConditions.notExists());
    // Merge simultaneous completion writes, never erase another timestamp.
    for (const other of Object.values(fields).filter((name) => name !== field)) {
      conditions = conditions.and(other, current[other] ? FilterConditions.equalTo(current[other]) : FilterConditions.notExists());
    }
    try {
      await kvs.transact().set(id, { ...current, [field]: new Date().toISOString() }, { entityName: DECISION_ENTITY, conditions }).execute();
      return true;
    } catch (error) {
      const saved = await readDecision(id);
      if (saved?.taskClaimId !== decision.taskClaimId || saved?.taskKey !== decision.taskKey) return false;
      if (saved[field]) return true;
      if (Object.values(fields).some((name) => saved?.[name] !== current[name])) continue;
      throw error;
    }
  }
  return false;
}
