import api, { route } from '@forge/api';
import { orphanClassification, recordReferences } from '../lib/cleanup';
import { BudgetExceeded } from './loadBudget';

// A missing issue has no readable project association. Conservatively exclude
// trash only when a principal with global ADMINISTER can see an empty trash.
// Admin resolvers already verify that permission asUser on every invocation.
async function excludeProjectTrash(budget, eventContext) {
  try {
    const principal = eventContext ? api.asApp() : api.asUser();
    if (eventContext) {
      const permission = await budget.run(() => principal.requestJira(
        route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } }));
      if (permission.status !== 200) return false;
      const access = await budget.run(() => permission.json());
      if (access.permissions?.ADMINISTER?.havePermission !== true) return false;
    }
    const response = await budget.run(() => principal.requestJira(
      route`/rest/api/3/project/search?status=deleted&startAt=0&maxResults=1`, { headers: { Accept: 'application/json' } }));
    if (response.status !== 200) return false;
    const page = await budget.run(() => response.json());
    // status=deleted means projects in the recycle bin, not permanent deletion.
    // A partial, malformed or unavailable response never proves trash is empty.
    return page.startAt === 0 && page.total === 0 && page.isLast === true && !page.nextPage
      && Array.isArray(page.values) && page.values.length === 0;
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    return false;
  }
}

export async function checkOrphan(record, budget, { eventContext = false } = {}) {
  const refs = recordReferences(record.entity, record.key, record.value);
  if (refs.length !== 2) return 'unknown';
  const statuses = [];
  for (const id of refs) {
    try {
      // Deliberate maintenance-only exception: never parse, return, or log a body.
      const response = await budget.run(() => api.asApp().requestJira(
        route`/rest/api/3/issue/${id}?fields=id`, { headers: { Accept: 'application/json' } }));
      statuses.push(response.status);
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      statuses.push(0);
    }
  }
  const trashExcluded = statuses.includes(404) && await excludeProjectTrash(budget, eventContext);
  return orphanClassification(refs, statuses, trashExcluded);
}
